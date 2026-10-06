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
  StoredActivity,
  StoredReaction,
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
          authorId: post.authorId,
          category: post.category,
          expiresAt: post.expiresAt ?? null,
          postVersion: post.postVersion ?? 1,
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

  async findComment(
    postId: string,
    commentId: string,
  ): Promise<StoredActivity<CommentRecord> | null> {
    return this.comments
      .findOne({ postId, commentId })
      .session(this.session ?? null)
      .lean() as Promise<StoredActivity<CommentRecord> | null>;
  }

  async findReaction(
    postId: string,
    userId: number,
  ): Promise<StoredReaction | null> {
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
          removedAt: reaction.removedAt ?? null,
          activityVersion: reaction.activityVersion ?? 1,
          bucketId: reaction.bucketId ?? 0,
        }
      : null;
  }

  async findParticipant(
    postId: string,
    userId: number,
  ): Promise<StoredActivity<ParticipantRecord> | null> {
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
          activityVersion: participant.activityVersion ?? 1,
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
    activityVersion: number,
  ): Promise<StoredActivity<ParticipantRecord> | null> {
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
            activityVersion,
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

  async reactivateReaction(
    reaction: ReactionRecord,
    activityVersion: number,
  ): Promise<void> {
    await this.reactions.updateOne(
      { postId: reaction.postId, userId: reaction.userId, type: reaction.type },
      {
        $set: {
          createdAt: reaction.createdAt,
          removedAt: null,
          activityVersion,
        },
      },
      { session: this.session },
    );
  }

  async removeReaction(
    postId: string,
    userId: number,
    now: Date,
    activityVersion: number,
  ): Promise<void> {
    // 기록을 지우지 않아 취소 후 재등록해도 버전과 관계의 식별자가 유지된다.
    await this.reactions.updateOne(
      { postId, userId, type: 'LIKE' },
      { $set: { removedAt: now, activityVersion } },
      { session: this.session },
    );
  }

  async deleteComment(
    postId: string,
    commentId: string,
    now: Date,
    activityVersion: number,
  ): Promise<void> {
    await this.comments.updateOne(
      { postId, commentId },
      {
        $set: {
          status: 'DELETED',
          deletedAt: now,
          updatedAt: now,
          activityVersion,
        },
      },
      { session: this.session },
    );
  }

  async leaveParticipant(
    postId: string,
    userId: number,
    now: Date,
    activityVersion: number,
  ): Promise<void> {
    await this.participants.updateOne(
      { postId, userId },
      { $set: { leftAt: now, activityVersion } },
      { session: this.session },
    );
  }

  async fenceActivities(postId: string, bucketCount: number): Promise<void> {
    // 활동은 선택한 카운터만 쓴다. 수명주기 변경은 모든 bucket을 써서 이전 ACTIVE
    // 스냅샷으로 진행 중인 활동과 충돌시킨다. 레거시의 없는 카운터도 반드시 생성한다.
    for (let bucketId = 0; bucketId < bucketCount; bucketId++) {
      for (const metric of [
        'commentCount',
        'reactionCount',
        'participantCount',
      ]) {
        await this.counters.updateOne(
          { postId, bucketId, metric },
          { $inc: { lifecycleFence: 1 }, $setOnInsert: { count: 0 } },
          { session: this.session, upsert: true },
        );
      }
    }
  }

  async changePostStatus(
    postId: string,
    status: 'DELETED' | 'EXPIRED',
    now: Date,
    postVersion: number,
  ): Promise<void> {
    await this.posts.updateOne(
      { postId },
      {
        $set: {
          status,
          postVersion,
          updatedAt: now,
          [status === 'DELETED' ? 'deletedAt' : 'expiredAt']: now,
        },
      },
      { session: this.session },
    );
  }

  async scheduleExpiration(
    postId: string,
    expiresAt: Date,
    now: Date,
  ): Promise<void> {
    await this.posts.updateOne(
      { postId },
      { $set: { expiresAt, updatedAt: now } },
      { session: this.session },
    );
  }

  async increment(
    postId: string,
    bucketId: number,
    counter: 'commentCount' | 'reactionCount' | 'participantCount',
    delta = 1,
  ): Promise<void> {
    // 같은 트랜잭션에서 콘텐츠와 카운터를 기록하되 Post 문서에는 쓰지 않는다.
    await this.counters.updateOne(
      { postId, bucketId, metric: counter },
      { $inc: { count: delta } },
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

  findComment(
    postId: string,
    commentId: string,
  ): Promise<StoredActivity<CommentRecord> | null> {
    return this.queries().findComment(postId, commentId);
  }

  findReaction(postId: string, userId: number): Promise<StoredReaction | null> {
    return this.queries().findReaction(postId, userId);
  }

  findParticipant(
    postId: string,
    userId: number,
  ): Promise<StoredActivity<ParticipantRecord> | null> {
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
    for (let attempt = 0; ; attempt++) {
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
        const duplicate = error as {
          code?: number;
          keyPattern?: Record<string, number>;
        };
        // 레거시 게시물의 첫 카운터 생성과 수명주기 fence가 경합하면 11000이 날 수 있다.
        // 엔터티의 중복 요청과 구분해 전체 트랜잭션을 새 스냅샷에서 제한적으로 재시도한다.
        if (
          duplicate.code === 11000 &&
          duplicate.keyPattern?.metric &&
          attempt < 3
        )
          continue;
        if (duplicate.code === 11000)
          throw new UniqueConflictError('Unique constraint violated');
        throw error;
      }
    }
  }
}
