import { randomUUID } from 'node:crypto';
import {
  createComment,
  createCommentReaction,
  createPost,
  createReaction,
  PostReactionType,
  joinParticipant,
  PostInactiveError,
  PostNotFoundError,
  ReactionConflictError,
  requireReactionSlot,
  requireActive,
} from '../domain/post.js';
import type {
  PostInput,
  CommentRecord,
  CommentReactionRecord,
  CommentReactionType,
  PostRecord,
  ReactionRecord,
  ParticipantRecord,
} from '../domain/post.js';
import {
  LocationDeniedError,
  ParticipationUnavailableError,
  UniqueConflictError,
} from './errors.js';
import { event } from './event.js';
import type { PartitionStrategy } from './partition.js';
import type {
  LocationAuthorization,
  PostStateQueries,
  PostTransaction,
  PostUnitOfWork,
} from './ports.js';

function participantView(participant: ParticipantRecord): ParticipantRecord {
  return {
    postId: participant.postId,
    userId: participant.userId,
    joinedAt: participant.joinedAt,
    lastSeenAt: participant.lastSeenAt,
    leftAt: participant.leftAt,
  };
}

async function active(transaction: PostTransaction, postId: string) {
  const post = await transaction.queries.findPost(postId);
  requireActive(post);
  return post;
}

export class CreatePost {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly authorization: LocationAuthorization,
  ) {}

  async execute(input: PostInput, authorId: number): Promise<PostRecord> {
    const now = new Date();
    const post = createPost(input, authorId, `post_${randomUUID()}`, now);
    // 위치 판정이 실패하면 MongoDB 트랜잭션과 Outbox 기록을 시작하지 않는다.
    await this.authorization.assertCanCreate(
      authorId,
      input.latitude,
      input.longitude,
      input.radiusM,
    );
    if (process.env.POST_REGION_ENABLED === 'true') {
      if (!this.authorization.resolveRegion)
        throw new ParticipationUnavailableError(
          'Region resolution unavailable',
        );
      post.region = await this.authorization.resolveRegion(
        input.latitude,
        input.longitude,
      );
    }
    await this.unitOfWork.execute(async ({ commands }) => {
      await commands.insertPost(post);
      await commands.appendEvent(
        event(
          post.postId,
          'PostCreated',
          {
            post: {
              postId: post.postId,
              authorId,
              latitude: input.latitude,
              longitude: input.longitude,
              radiusM: input.radiusM,
              category: input.category,
              expiresAt: null,
            },
            postVersion: 1,
          },
          now,
        ),
      );
    });
    return post;
  }
}

export class CreateComment {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly queries: PostStateQueries,
    private readonly partitionStrategy: PartitionStrategy,
    private readonly authorization: LocationAuthorization,
  ) {}

  async execute(
    postId: string,
    content: string,
    authorId: number,
    mutationId?: string,
    mediaIds: string[] = [],
    parentCommentId: string | null = null,
  ): Promise<CommentRecord> {
    const post = await this.queries.findPost(postId);
    requireActive(post);
    // 이미 성공한 mutation 재시도는 새 쓰기가 아니므로 위치가 만료돼도 기존 결과를 반환한다.
    if (mutationId) {
      const existing = await this.queries.findCommentByMutation(
        postId,
        authorId,
        mutationId,
      );
      if (existing) return existing;
    }
    const participant = await this.queries.findParticipant(postId, authorId);
    if (!participant || participant.leftAt !== null)
      throw new LocationDeniedError('Active participation required');
    if (!post.locationSnapshot || post.radiusM === undefined)
      throw new ParticipationUnavailableError('Post location unavailable');
    // 네트워크 호출은 트랜잭션 밖에서 수행하고 참여·게시물 상태는 쓰기 직전에 재확인한다.
    await this.authorization.assertCanJoin(
      authorId,
      postId,
      post.locationSnapshot.latitude,
      post.locationSnapshot.longitude,
      post.radiusM,
    );
    let verified = post.radiusM <= 150;
    if (!verified) {
      try {
        await this.authorization.assertCanJoin(
          authorId,
          postId,
          post.locationSnapshot.latitude,
          post.locationSnapshot.longitude,
          150,
        );
        verified = true;
      } catch (error) {
        if (!(error instanceof LocationDeniedError)) throw error;
      }
    }
    const now = new Date();
    const comment = createComment(
      postId,
      authorId,
      content,
      `comment_${randomUUID()}`,
      now,
      mediaIds,
    );
    comment.parentCommentId = parentCommentId;
    comment.verified = verified;
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        const post = await active(transaction, postId);
        if (parentCommentId) {
          const parent = await transaction.queries.findComment(
            postId,
            parentCommentId,
          );
          if (
            !parent ||
            parent.status !== 'ACTIVE' ||
            parent.parentCommentId ||
            !(await transaction.commands.fenceParentComment(
              postId,
              parentCommentId,
            ))
          )
            throw new PostNotFoundError(
              'Active top-level parent comment required',
            );
        }
        // 재연결 후 같은 작성 요청이 다시 와도 댓글과 카운터를 한 번만 기록한다.
        if (mutationId) {
          const existing = await transaction.queries.findCommentByMutation(
            postId,
            authorId,
            mutationId,
          );
          if (existing) return existing;
        }
        const participant = await transaction.queries.findParticipant(
          postId,
          authorId,
        );
        if (!participant || participant.leftAt !== null)
          throw new LocationDeniedError('Active participation required');
        const bucketId = this.partitionStrategy.resolveBucket(
          comment.commentId,
          post.bucketCount,
        );
        await transaction.commands.insertComment(
          { ...comment, bucketId },
          mutationId,
        );
        await transaction.commands.increment(postId, bucketId, 'commentCount');
        await transaction.commands.appendEvent(
          event(
            postId,
            'PostCommentCreated',
            {
              comment,
              postAuthorId: post.authorId,
              postCategory: post.category,
              activityVersion: 1,
            },
            now,
          ),
        );
        return comment;
      });
    } catch (error) {
      // 두 요청이 동시에 기존 댓글을 못 본 경우에는 유일 인덱스 충돌 뒤 저장된 결과를 읽는다.
      if (mutationId && error instanceof UniqueConflictError) {
        const existing = await this.queries.findCommentByMutation(
          postId,
          authorId,
          mutationId,
        );
        if (existing) return existing;
      }
      throw error;
    }
  }
}

export class CreateReaction {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly queries: PostStateQueries,
    private readonly partitionStrategy: PartitionStrategy,
  ) {}

  async execute(
    postId: string,
    userId: number,
    type: PostReactionType,
  ): Promise<ReactionRecord> {
    const now = new Date();
    const reaction = createReaction(postId, userId, type, now);
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        const post = await active(transaction, postId);
        const activeReaction = requireReactionSlot(
          await transaction.queries.findActiveReaction(postId, userId),
          type,
        );
        if (activeReaction)
          return {
            postId: activeReaction.postId,
            userId: activeReaction.userId,
            type: activeReaction.type,
            createdAt: activeReaction.createdAt,
          };
        const existing = await transaction.queries.findReaction(
          postId,
          userId,
          type,
        );
        const bucketId = this.partitionStrategy.resolveBucket(
          `${userId}:${reaction.type}`,
          post.bucketCount,
        );
        const activityVersion = existing
          ? (existing.activityVersion ?? 1) + 1
          : 1;
        if (existing)
          await transaction.commands.reactivateReaction(
            reaction,
            activityVersion,
          );
        else
          await transaction.commands.insertReaction({ ...reaction, bucketId });
        await transaction.commands.increment(
          postId,
          existing?.bucketId ?? bucketId,
          'reactionCount',
        );
        await transaction.commands.appendEvent(
          event(
            postId,
            'PostReactionCreated',
            {
              reaction,
              postAuthorId: post.authorId,
              postCategory: post.category,
              activityVersion,
            },
            now,
          ),
        );
        return reaction;
      });
    } catch (error) {
      // 다른 종류가 동시에 커밋됐다면 부분 유일 인덱스 충돌을 도메인 오류로 바꾼다.
      if (error instanceof UniqueConflictError) {
        const existing = requireReactionSlot(
          await this.queries.findActiveReaction(postId, userId),
          type,
        );
        if (existing)
          return {
            postId: existing.postId,
            userId: existing.userId,
            type: existing.type,
            createdAt: existing.createdAt,
          };
        throw new ReactionConflictError('Reaction changed; retry the request');
      }
      throw error;
    }
  }
}

export class CreateCommentReaction {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly queries: PostStateQueries,
  ) {}

  async execute(
    postId: string,
    commentId: string,
    userId: number,
    type: CommentReactionType,
  ): Promise<CommentReactionRecord> {
    const reaction = createCommentReaction(
      postId,
      commentId,
      userId,
      type,
      new Date(),
    );
    try {
      return await this.unitOfWork.execute(async (tx) => {
        await active(tx, postId);
        const comment = await tx.queries.findComment(postId, commentId);
        if (!comment) throw new PostNotFoundError('Comment not found');
        if (comment.status !== 'ACTIVE')
          throw new PostInactiveError('Comment is not active');
        const activeReaction = requireReactionSlot(
          await tx.queries.findActiveCommentReaction(commentId, userId),
          type,
        );
        if (activeReaction)
          return {
            postId,
            commentId,
            userId,
            type,
            createdAt: activeReaction.createdAt,
          };
        const existing = await tx.queries.findCommentReaction(
          commentId,
          userId,
          type,
        );
        if (existing) await tx.commands.reactivateCommentReaction(reaction);
        else await tx.commands.insertCommentReaction(reaction);
        // 댓글 문서 쓰기는 댓글 삭제와 충돌하고, bucket 쓰기는 게시물 종료와 충돌한다.
        if (
          !(await tx.commands.incrementCommentReaction(
            postId,
            commentId,
            type,
            1,
          ))
        )
          throw new PostInactiveError('Comment is not active');
        await tx.commands.increment(
          postId,
          comment.bucketId ?? 0,
          'commentReactionCount',
        );
        return reaction;
      });
    } catch (error) {
      if (error instanceof UniqueConflictError) {
        const existing = requireReactionSlot(
          await this.queries.findActiveCommentReaction(commentId, userId),
          type,
        );
        if (existing)
          return {
            postId,
            commentId,
            userId,
            type,
            createdAt: existing.createdAt,
          };
        throw new ReactionConflictError('Reaction changed; retry the request');
      }
      throw error;
    }
  }
}

export class JoinPost {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly queries: PostStateQueries,
    private readonly authorization: LocationAuthorization,
    private readonly partitionStrategy: PartitionStrategy,
  ) {}

  async execute(postId: string, userId: number): Promise<ParticipantRecord> {
    const post = await this.queries.findPost(postId);
    requireActive(post);
    if (!post.locationSnapshot || post.radiusM === undefined)
      throw new ParticipationUnavailableError('Post location unavailable');
    await this.authorization.assertCanJoin(
      userId,
      postId,
      post.locationSnapshot.latitude,
      post.locationSnapshot.longitude,
      post.radiusM,
    );
    const now = new Date();
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        const activePost = await active(transaction, postId);
        const existing = await transaction.queries.findParticipant(
          postId,
          userId,
        );
        // 저장용 버전은 HTTP 및 기존 participant 객체에 노출하지 않는다.
        const clean = existing ? participantView(existing) : null;
        const decision = joinParticipant(clean, postId, userId, now);
        const activityVersion = existing
          ? (existing.activityVersion ?? 1) + 1
          : 1;
        if (!decision.joined) return decision.participant;
        // 떠났다가 돌아온 사용자는 기존 참여 기록을 되살리고 새 참여 이벤트를 남긴다.
        if (existing) {
          const rejoined = await transaction.commands.rejoinParticipant(
            decision.participant,
            activityVersion,
          );
          if (!rejoined)
            return participantView(
              (await transaction.queries.findParticipant(postId, userId)) ??
                decision.participant,
            );
        } else {
          await transaction.commands.insertParticipant(decision.participant);
        }
        const bucketId = this.partitionStrategy.resolveBucket(
          String(userId),
          activePost.bucketCount,
        );
        await transaction.commands.increment(
          postId,
          bucketId,
          'participantCount',
        );
        await transaction.commands.appendEvent(
          event(
            postId,
            'PostParticipantJoined',
            {
              participant: decision.participant,
              postAuthorId: activePost.authorId,
              postCategory: activePost.category,
              activityVersion,
            },
            now,
          ),
        );
        return decision.participant;
      });
    } catch (error) {
      if (error instanceof UniqueConflictError) {
        const existing = await this.queries.findParticipant(postId, userId);
        if (existing?.leftAt === null) return participantView(existing);
      }
      throw error;
    }
  }
}
