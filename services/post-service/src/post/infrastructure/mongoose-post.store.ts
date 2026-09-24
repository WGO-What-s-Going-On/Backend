import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ClientSession, Connection, Model } from 'mongoose';
import type { PostCommands, PostStateQueries, PostUnitOfWork, PostTransaction, OutboxEvent } from '../application/ports.js';
import { UniqueConflictError } from '../application/errors.js';
import type { CommentRecord, ParticipantRecord, PostRecord, PostState, ReactionRecord } from '../domain/post.js';
import { PostInactiveError } from '../domain/post.js';

class MongoQueries implements PostStateQueries {
  constructor(
    private readonly posts: Model<any>,
    private readonly reactions: Model<any>,
    private readonly participants: Model<any>,
    private readonly session?: ClientSession,
  ) {}

  async findPost(postId: string): Promise<PostState | null> {
    const post = await this.posts.findOne({ postId }).session(this.session ?? null).lean();
    return post ? { postId: post.postId, status: post.status } : null;
  }

  async findReaction(postId: string, userId: number): Promise<ReactionRecord | null> {
    const reaction = await this.reactions.findOne({ postId, userId, type: 'LIKE' }).session(this.session ?? null).lean();
    return reaction ? { postId: reaction.postId, userId: reaction.userId, type: 'LIKE', createdAt: reaction.createdAt } : null;
  }

  async findParticipant(postId: string, userId: number): Promise<ParticipantRecord | null> {
    const participant = await this.participants.findOne({ postId, userId }).session(this.session ?? null).lean();
    return participant ? { postId: participant.postId, userId: participant.userId, joinedAt: participant.joinedAt, lastSeenAt: participant.lastSeenAt, leftAt: participant.leftAt } : null;
  }
}

class MongoCommands implements PostCommands {
  constructor(
    private readonly posts: Model<any>,
    private readonly comments: Model<any>,
    private readonly reactions: Model<any>,
    private readonly participants: Model<any>,
    private readonly outbox: Model<any>,
    private readonly session: ClientSession,
  ) {}

  async insertPost(post: PostRecord): Promise<void> {
    await this.posts.create([post], { session: this.session });
  }

  async insertComment(comment: CommentRecord): Promise<void> {
    await this.comments.create([comment], { session: this.session });
  }

  async insertReaction(reaction: ReactionRecord): Promise<void> {
    await this.reactions.create([reaction], { session: this.session });
  }

  async insertParticipant(participant: ParticipantRecord): Promise<void> {
    await this.participants.create([participant], { session: this.session });
  }

  async rejoinParticipant(participant: ParticipantRecord): Promise<ParticipantRecord | null> {
    const updated = await this.participants.findOneAndUpdate(
      { postId: participant.postId, userId: participant.userId, leftAt: { $ne: null } },
      { $set: { joinedAt: participant.joinedAt, lastSeenAt: participant.lastSeenAt, leftAt: null } },
      { session: this.session, new: true },
    ).lean();
    return updated ? { postId: updated.postId, userId: updated.userId, joinedAt: updated.joinedAt, lastSeenAt: updated.lastSeenAt, leftAt: updated.leftAt } : null;
  }

  async increment(postId: string, counter: 'commentCount' | 'reactionCount' | 'participantCount', now: Date): Promise<void> {
    const result = await this.posts.updateOne({ postId, status: 'ACTIVE' }, { $inc: { [`counters.${counter}`]: 1 }, $set: { updatedAt: now } }, { session: this.session });
    if (result.matchedCount !== 1) throw new PostInactiveError('Post is not active');
  }

  async appendEvent(event: OutboxEvent): Promise<void> {
    await this.outbox.create([{
      ...event, status: 'PENDING', claimedBy: null, claimedUntil: null,
      attemptCount: 0, nextAttemptAt: event.occurredAt, createdAt: event.occurredAt,
      publishedAt: null, streamId: null,
    }], { session: this.session });
  }
}

@Injectable()
export class MongoosePostStore implements PostUnitOfWork, PostStateQueries {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Post') private readonly posts: Model<any>,
    @InjectModel('Comment') private readonly comments: Model<any>,
    @InjectModel('Reaction') private readonly reactions: Model<any>,
    @InjectModel('Participant') private readonly participants: Model<any>,
    @InjectModel('Outbox') private readonly outbox: Model<any>,
  ) {}

  findPost(postId: string): Promise<PostState | null> {
    return this.queries().findPost(postId);
  }

  findReaction(postId: string, userId: number): Promise<ReactionRecord | null> {
    return this.queries().findReaction(postId, userId);
  }

  findParticipant(postId: string, userId: number): Promise<ParticipantRecord | null> {
    return this.queries().findParticipant(postId, userId);
  }

  private queries(session?: ClientSession): PostStateQueries {
    return new MongoQueries(this.posts, this.reactions, this.participants, session);
  }

  async execute<T>(work: (transaction: PostTransaction) => Promise<T>): Promise<T> {
    try {
      return await this.connection.transaction((session) => work({
        queries: this.queries(session),
        commands: new MongoCommands(this.posts, this.comments, this.reactions, this.participants, this.outbox, session),
      }));
    } catch (error) {
      if ((error as { code?: number }).code === 11000) throw new UniqueConflictError('Unique constraint violated');
      throw error;
    }
  }
}
