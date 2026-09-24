import { randomUUID } from 'node:crypto';
import { createComment, createPost, createReaction, joinParticipant, requireActive } from '../domain/post.js';
import type { PostInput, CommentRecord, PostRecord, ReactionRecord, ParticipantRecord } from '../domain/post.js';
import { UniqueConflictError } from './errors.js';
import { event } from './event.js';
import type { ParticipationAuthorization, PostStateQueries, PostTransaction, PostUnitOfWork } from './ports.js';

async function active(transaction: PostTransaction, postId: string): Promise<void> {
  requireActive(await transaction.queries.findPost(postId));
}

export class CreatePost {
  constructor(private readonly unitOfWork: PostUnitOfWork) {}

  async execute(input: PostInput, authorId: number): Promise<PostRecord> {
    const now = new Date();
    const post = createPost(input, authorId, `post_${randomUUID()}`, now);
    await this.unitOfWork.execute(async ({ commands }) => {
      await commands.insertPost(post);
      await commands.appendEvent(event(post.postId, 'PostCreated', {
        post: { postId: post.postId, authorId, latitude: input.latitude, longitude: input.longitude, radiusM: input.radiusM, category: input.category, expiresAt: null },
      }, now));
    });
    return post;
  }
}

export class CreateComment {
  constructor(private readonly unitOfWork: PostUnitOfWork) {}

  async execute(postId: string, content: string, authorId: number): Promise<CommentRecord> {
    const now = new Date();
    const comment = createComment(postId, authorId, content, `comment_${randomUUID()}`, now);
    await this.unitOfWork.execute(async (transaction) => {
      await active(transaction, postId);
      await transaction.commands.insertComment(comment);
      await transaction.commands.increment(postId, 'commentCount', now);
      await transaction.commands.appendEvent(event(postId, 'PostCommentCreated', { comment }, now));
    });
    return comment;
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
        await transaction.commands.appendEvent(event(postId, 'PostReactionCreated', { reaction }, now));
        return reaction;
      });
    } catch (error) {
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
        const existing = await transaction.queries.findParticipant(postId, userId);
        const decision = joinParticipant(existing, postId, userId, now);
        if (!decision.joined) return decision.participant;
        if (existing) {
          const rejoined = await transaction.commands.rejoinParticipant(decision.participant);
          if (!rejoined) return (await transaction.queries.findParticipant(postId, userId)) ?? decision.participant;
        } else {
          await transaction.commands.insertParticipant(decision.participant);
        }
        await transaction.commands.increment(postId, 'participantCount', now);
        await transaction.commands.appendEvent(event(postId, 'PostParticipantJoined', { participant: decision.participant }, now));
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
