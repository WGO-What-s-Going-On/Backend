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
import { UniqueConflictError } from './errors.js';
import { event } from './event.js';
import type {
  ParticipationAuthorization,
  PostStateQueries,
  PostTransaction,
  PostUnitOfWork,
} from './ports.js';

async function active(
  transaction: PostTransaction,
  postId: string,
): Promise<void> {
  requireActive(await transaction.queries.findPost(postId));
}

export class CreatePost {
  constructor(private readonly unitOfWork: PostUnitOfWork) {}

  async execute(input: PostInput, authorId: number): Promise<PostRecord> {
    const now = new Date();
    const post = createPost(input, authorId, `post_${randomUUID()}`, now);
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
        await active(transaction, postId);
        // 재연결 후 같은 작성 요청이 다시 와도 댓글과 카운터를 한 번만 기록한다.
        if (mutationId) {
          const existing = await transaction.queries.findCommentByMutation(
            postId,
            authorId,
            mutationId,
          );
          if (existing) return existing;
        }
        await transaction.commands.insertComment(comment, mutationId);
        await transaction.commands.increment(postId, 'commentCount', now);
        await transaction.commands.appendEvent(
          event(postId, 'PostCommentCreated', { comment }, now),
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
  ) {}

  async execute(postId: string, userId: number): Promise<ReactionRecord> {
    const now = new Date();
    const reaction = createReaction(postId, userId, now);
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        await active(transaction, postId);
        const existing = await transaction.queries.findReaction(postId, userId);
        if (existing) return existing;
        await transaction.commands.insertReaction(reaction);
        await transaction.commands.increment(postId, 'reactionCount', now);
        await transaction.commands.appendEvent(
          event(postId, 'PostReactionCreated', { reaction }, now),
        );
        return reaction;
      });
    } catch (error) {
      // 동시에 들어온 LIKE 요청도 기존 반응을 반환해 카운터와 이벤트가 늘지 않게 한다.
      if (error instanceof UniqueConflictError) {
        const existing = await this.queries.findReaction(postId, userId);
        if (existing) return existing;
      }
      throw error;
    }
  }
}

export class JoinPost {
  constructor(
    private readonly unitOfWork: PostUnitOfWork,
    private readonly queries: PostStateQueries,
    private readonly authorization: ParticipationAuthorization,
  ) {}

  async execute(postId: string, userId: number): Promise<ParticipantRecord> {
    await this.authorization.assertCanJoin(postId, userId);
    const now = new Date();
    try {
      return await this.unitOfWork.execute(async (transaction) => {
        await active(transaction, postId);
        const existing = await transaction.queries.findParticipant(
          postId,
          userId,
        );
        const decision = joinParticipant(existing, postId, userId, now);
        if (!decision.joined) return decision.participant;
        // 떠났다가 돌아온 사용자는 기존 참여 기록을 되살리고 새 참여 이벤트를 남긴다.
        if (existing) {
          const rejoined = await transaction.commands.rejoinParticipant(
            decision.participant,
          );
          if (!rejoined)
            return (
              (await transaction.queries.findParticipant(postId, userId)) ??
              decision.participant
            );
        } else {
          await transaction.commands.insertParticipant(decision.participant);
        }
        await transaction.commands.increment(postId, 'participantCount', now);
        await transaction.commands.appendEvent(
          event(
            postId,
            'PostParticipantJoined',
            { participant: decision.participant },
            now,
          ),
        );
        return decision.participant;
      });
    } catch (error) {
      if (error instanceof UniqueConflictError) {
        const existing = await this.queries.findParticipant(postId, userId);
        if (existing?.leftAt === null) return existing;
      }
      throw error;
    }
  }
}
