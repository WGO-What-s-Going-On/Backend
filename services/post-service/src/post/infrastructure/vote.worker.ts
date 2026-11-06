import { createLogger } from '../../observability/logging.js';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { MongooseVote } from './mongoose-vote.js';
import { eventWorkerConfig } from './worker-config.js';

@Injectable()
export class VoteWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('post-service', 'vote');
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopped = false;
  private afterPostId: string | undefined;

  constructor(
    @InjectModel('Post') private readonly posts: Model<any>,
    private readonly votes: MongooseVote,
  ) {}

  onModuleInit(): void {
    const poll = () =>
      void this.runOnce().catch((error) =>
        this.logger.failure(
          'vote.poll',
          error,
          'VOTE_POLL_FAILED',
          'Vote scan failed',
          {},
          true,
        ),
      );
    this.timer = setInterval(poll, eventWorkerConfig().expirationPollMs);
    this.timer.unref();
    poll();
  }

  async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.running) return this.running;
    this.running = this.selectBatch();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async selectBatch(): Promise<void> {
    const due = await this.posts
      .find(
        {
          status: 'ACTIVE',
          'vote.status': 'PENDING',
          closedAt: null,
          $or: [{ expiresAt: null }, { expiresAt: { $gt: new Date() } }],
          ...(this.afterPostId ? { postId: { $gt: this.afterPostId } } : {}),
        },
        'postId -_id',
      )
      .sort({ postId: 1 })
      .limit(eventWorkerConfig().batchSize)
      .lean();
    // 조건 미달 게시물이 앞 배치를 계속 차지하지 않도록 커서를 순환한다.
    this.afterPostId =
      due.length === eventWorkerConfig().batchSize
        ? due.at(-1)?.postId
        : undefined;
    for (const post of due) {
      if (this.stopped) break;
      try {
        await this.votes.selectDue(post.postId);
      } catch (error) {
        this.logger.failure(
          'vote.selection',
          error,
          'VOTE_SELECTION_FAILED',
          'Vote candidate selection failed',
          { postId: post.postId },
          true,
        );
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
