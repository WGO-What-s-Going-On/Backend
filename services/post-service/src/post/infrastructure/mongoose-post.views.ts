import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { InjectConnection, InjectModel } from '@nestjs/mongoose';
import { Schema, type Connection, type Model } from 'mongoose';
import {
  PostNotFoundError,
  type PostRecord,
  type PostState,
} from '../domain/post.js';
import {
  PARTITION_STRATEGY,
  type PartitionStrategy,
} from '../application/partition.js';

export interface DailyPostView {
  postId: string;
  userId: number;
  day: string;
  createdAt: Date;
}

export const DailyPostViewSchema = new Schema<DailyPostView>(
  {
    postId: { type: String, required: true },
    userId: { type: Number, required: true },
    day: { type: String, required: true },
    createdAt: { type: Date, required: true },
  },
  { versionKey: false },
);
DailyPostViewSchema.index({ postId: 1, userId: 1, day: 1 }, { unique: true });

type ViewPost = Pick<PostRecord, 'postId' | 'status' | 'counters'> &
  Pick<PostState, 'bucketCount'>;
interface ViewCounter {
  postId: string;
  bucketId: number;
  metric: string;
  count: number;
}

function retryableDuplicate(error: unknown): boolean {
  if (
    !error ||
    typeof error !== 'object' ||
    !('code' in error) ||
    error.code !== 11000 ||
    !('keyPattern' in error)
  )
    return false;
  const pattern = error.keyPattern;
  if (!pattern || typeof pattern !== 'object') return false;
  const fields = Object.keys(pattern).sort().join(',');
  return fields === 'day,postId,userId' || fields === 'bucketId,metric,postId';
}

@Injectable()
export class MongoosePostViews implements OnModuleInit {
  constructor(
    @InjectConnection() private readonly connection: Connection,
    @InjectModel('Post') private readonly posts: Model<ViewPost>,
    @InjectModel('DailyPostView') private readonly views: Model<DailyPostView>,
    @InjectModel('Counter') private readonly counters: Model<ViewCounter>,
    @Inject(PARTITION_STRATEGY) private readonly partition: PartitionStrategy,
  ) {}

  async onModuleInit() {
    // 중복 방지는 인덱스에 의존하므로 요청을 받기 전에 생성 완료를 기다린다.
    await Promise.all([
      this.views.createIndexes(),
      this.counters.createIndexes(),
    ]);
  }

  async record(input: {
    postId: string;
    userId: number;
    at: Date;
  }): Promise<number> {
    // 날짜를 트랜잭션 밖에서 고정해 자정을 넘는 재시도도 같은 조회로 처리한다.
    const day = new Date(input.at.getTime() + 9 * 60 * 60 * 1000)
      .toISOString()
      .slice(0, 10);
    for (let attempt = 0; ; attempt++) {
      try {
        return await this.connection.transaction(async (session) => {
          const post = await this.posts
            .findOne({ postId: input.postId })
            .session(session)
            .lean();
          if (!post || post.status === 'DELETED' || post.status === 'HIDDEN')
            throw new PostNotFoundError('Post not found');
          const receipt = await this.views.updateOne(
            { postId: input.postId, userId: input.userId, day },
            { $setOnInsert: { createdAt: input.at } },
            { session, upsert: true },
          );
          if (receipt.upsertedCount === 1) {
            await this.counters.updateOne(
              {
                postId: input.postId,
                bucketId: this.partition.resolveBucket(
                  String(input.userId),
                  post.bucketCount ?? 1,
                ),
                metric: 'viewCount',
              },
              { $inc: { count: 1 } },
              { session, upsert: true },
            );
          }
          const increments = await this.counters
            .find({ postId: input.postId, metric: 'viewCount' }, 'count')
            .session(session)
            .lean();
          return (
            (post.counters?.viewCount ?? 0) +
            increments.reduce((total, row) => total + row.count, 0)
          );
        });
      } catch (error) {
        // 첫 기록과 bucket 생성의 유니크 충돌은 새 트랜잭션에서 다시 읽는다.
        if (attempt < 3 && retryableDuplicate(error)) continue;
        throw error;
      }
    }
  }
}
