import { randomUUID } from 'node:crypto';
import {
  createComment,
  createPost,
  createReaction,
  joinParticipant,
  requireActive,
} from '../domain/post.js';
import type {
  PostInput,
  CommentRecord,
  PostRecord,
  ReactionRecord,
  ParticipantRecord,
} from '../domain/post.js';
import {
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
  ) {}

  async execute(
    postId: string,
    content: string,
    authorId: number,
    mutationId?: string,
  ): Promise<CommentRecord> {
    const now = new Date();
    const comment = createComment(
      postId,
      authorId,
      content,
      `comment_${randomUUID()}`,
      now,
    );
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        const post = await active(transaction, postId);
        // 재연결 후 같은 작성 요청이 다시 와도 댓글과 카운터를 한 번만 기록한다.
        if (mutationId) {
          const existing = await transaction.queries.findCommentByMutation(
            postId,
            authorId,
            mutationId,
          );
          if (existing) return existing;
        }
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

  async execute(postId: string, userId: number): Promise<ReactionRecord> {
    const now = new Date();
    const reaction = createReaction(postId, userId, now);
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        const post = await active(transaction, postId);
        const existing = await transaction.queries.findReaction(postId, userId);
        if (existing && !existing.removedAt)
          return {
            postId: existing.postId,
            userId: existing.userId,
            type: existing.type,
            createdAt: existing.createdAt,
          };
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
      // 동시에 들어온 LIKE 요청도 기존 반응을 반환해 카운터와 이벤트가 늘지 않게 한다.
      if (error instanceof UniqueConflictError) {
        const existing = await this.queries.findReaction(postId, userId);
        if (existing && !existing.removedAt)
          return {
            postId: existing.postId,
            userId: existing.userId,
            type: existing.type,
            createdAt: existing.createdAt,
          };
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
