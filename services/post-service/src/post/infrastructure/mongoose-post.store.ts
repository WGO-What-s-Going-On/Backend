import { Injectable } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { ConfigService } from '@nestjs/config';
import type { ClientSession, Connection, Model } from 'mongoose';
import type {
  PostCommands,
  PostStateQueries,
  PostUnitOfWork,
  PostTransaction,
  OutboxEvent,
} from '../application/ports.js';
import { UniqueConflictError } from '../application/errors.js';
import type {
  CommentRecord,
  ParticipantRecord,
  PostRecord,
  PostState,
  ReactionRecord,
} from '../domain/post.js';
import { OutboxWorker } from './outbox.worker.js';

class MongoQueries implements PostStateQueries {
  constructor(
    private readonly posts: Model<any>,
    private readonly comments: Model<any>,
    private readonly reactions: Model<any>,
    private readonly participants: Model<any>,
    private readonly session?: ClientSession,
  ) {}

  async findPost(postId: string): Promise<PostState | null> {
    const post = await this.posts
      .findOne({ postId })
      .session(this.session ?? null)
      .lean();
    return post
      ? {
          postId: post.postId,
          status: post.status,
          bucketCount: post.bucketCount ?? 1,
          locationSnapshot: post.locationSnapshot,
          radiusM: post.radiusM,
        }
      : null;
  }

  async findCommentByMutation(
    postId: string,
    authorId: number,
    mutationId: string,
  ): Promise<CommentRecord | null> {
    const comment = await this.comments
      .findOne({ postId, authorId, mutationId })
      .session(this.session ?? null)
      .lean();
    return comment
      ? {
          commentId: comment.commentId,
          postId,
          authorId,
          content: comment.content,
          status: comment.status,
          createdAt: comment.createdAt,
          updatedAt: comment.updatedAt,
        }
      : null;
  }

  async findReaction(
    postId: string,
    userId: number,
  ): Promise<ReactionRecord | null> {
    const reaction = await this.reactions
      .findOne({ postId, userId, type: 'LIKE' })
      .session(this.session ?? null)
      .lean();
    return reaction
      ? {
          postId: reaction.postId,
          userId: reaction.userId,
          type: 'LIKE',
          createdAt: reaction.createdAt,
        }
      : null;
  }

  async findParticipant(
    postId: string,
    userId: number,
  ): Promise<ParticipantRecord | null> {
    const participant = await this.participants
      .findOne({ postId, userId })
      .session(this.session ?? null)
      .lean();
    return participant
      ? {
          postId: participant.postId,
          userId: participant.userId,
          joinedAt: participant.joinedAt,
          lastSeenAt: participant.lastSeenAt,
          leftAt: participant.leftAt,
        }
      : null;
  }
}

class MongoCommands implements PostCommands {
  constructor(
    private readonly posts: Model<any>,
    private readonly comments: Model<any>,
    private readonly reactions: Model<any>,
    private readonly participants: Model<any>,
    private readonly outbox: Model<any>,
    private readonly counters: Model<any>,
    private readonly bucketCount: number,
    private readonly session: ClientSession,
  ) {}

  async insertPost(post: PostRecord): Promise<void> {
    await this.posts.create([{ ...post, bucketCount: this.bucketCount }], {
      session: this.session,
    });
    const rows = Array.from({ length: this.bucketCount }, (_, bucketId) =>
      (['commentCount', 'reactionCount', 'participantCount'] as const).map(
        (metric) => ({ postId: post.postId, bucketId, metric, count: 0 }),
      ),
    ).flat();
    await this.counters.create(rows, { session: this.session, ordered: true });
  }

  async insertComment(
    comment: CommentRecord & { bucketId: number },
    mutationId?: string,
  ): Promise<void> {
    await this.comments.create(
      [{ ...comment, ...(mutationId ? { mutationId } : {}) }],
      { session: this.session },
    );
  }

  async insertReaction(
    reaction: ReactionRecord & { bucketId: number },
  ): Promise<void> {
    await this.reactions.create([reaction], { session: this.session });
  }

  async insertParticipant(participant: ParticipantRecord): Promise<void> {
    await this.participants.create([participant], { session: this.session });
  }

  async rejoinParticipant(
    participant: ParticipantRecord,
  ): Promise<ParticipantRecord | null> {
    const updated = await this.participants
      .findOneAndUpdate(
        {
          postId: participant.postId,
          userId: participant.userId,
          leftAt: { $ne: null },
        },
        {
          $set: {
            joinedAt: participant.joinedAt,
            lastSeenAt: participant.lastSeenAt,
            leftAt: null,
          },
        },
        { session: this.session, new: true },
      )
      .lean();
    return updated
      ? {
          postId: updated.postId,
          userId: updated.userId,
          joinedAt: updated.joinedAt,
          lastSeenAt: updated.lastSeenAt,
          leftAt: updated.leftAt,
        }
      : null;
  }

  async increment(
    postId: string,
    bucketId: number,
    counter: 'commentCount' | 'reactionCount' | 'participantCount',
  ): Promise<void> {
    // 같은 트랜잭션에서 콘텐츠와 카운터를 기록하되 Post 문서에는 쓰지 않는다.
    await this.counters.updateOne(
      { postId, bucketId, metric: counter },
      { $inc: { count: 1 } },
      { session: this.session, upsert: true },
    );
  }

  async appendEvent(event: OutboxEvent): Promise<void> {
    await this.outbox.create(
      [
        {
          ...event,
          status: 'PENDING',
          claimedBy: null,
          claimedUntil: null,
          attemptCount: 0,
          nextAttemptAt: event.occurredAt,
          createdAt: event.occurredAt,
          publishedAt: null,
          streamId: null,
        },
      ],
      { session: this.session },
    );
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
    @InjectModel('Counter') private readonly counters: Model<any>,
    private readonly config: ConfigService,
    private readonly outboxWorker: OutboxWorker,
  ) {}

  findPost(postId: string): Promise<PostState | null> {
    return this.queries().findPost(postId);
  }

  findCommentByMutation(
    postId: string,
    authorId: number,
    mutationId: string,
  ): Promise<CommentRecord | null> {
    return this.queries().findCommentByMutation(postId, authorId, mutationId);
  }

  findReaction(postId: string, userId: number): Promise<ReactionRecord | null> {
    return this.queries().findReaction(postId, userId);
  }

  findParticipant(
    postId: string,
    userId: number,
  ): Promise<ParticipantRecord | null> {
    return this.queries().findParticipant(postId, userId);
  }

  private queries(session?: ClientSession): PostStateQueries {
    return new MongoQueries(
      this.posts,
      this.comments,
      this.reactions,
      this.participants,
      session,
    );
  }

  async execute<T>(
    work: (transaction: PostTransaction) => Promise<T>,
  ): Promise<T> {
    try {
      // 도메인 데이터·카운터·Outbox가 함께 커밋되거나 함께 롤백된다.
      const result = await this.connection.transaction((session) =>
        work({
          queries: this.queries(session),
          commands: new MongoCommands(
            this.posts,
            this.comments,
            this.reactions,
            this.participants,
            this.outbox,
            this.counters,
            this.config.getOrThrow<number>('post.bucketCount'),
            session,
          ),
        }),
      );
      // 커밋이 끝난 뒤에만 발행을 깨운다. 실패한 트랜잭션의 이벤트는 보이지 않아야 한다.
      this.outboxWorker.wake();
      return result;
    } catch (error) {
      if ((error as { code?: number }).code === 11000)
        throw new UniqueConflictError('Unique constraint violated');
      throw error;
    }
  }
}
