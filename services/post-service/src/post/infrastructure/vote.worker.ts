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
          voteAt: { $lte: new Date() },
        },
        'postId -_id',
      )
      .sort({ voteAt: 1, postId: 1 })
      .limit(eventWorkerConfig().batchSize)
      .lean();
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
