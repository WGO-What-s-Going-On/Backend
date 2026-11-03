import { createLogger } from '../../observability/logging.js';
import { Injectable, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import { PostLifecycle } from '../application/lifecycle.js';
import { eventWorkerConfig } from './worker-config.js';

@Injectable()
export class ExpirationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('post-service', 'post');
  private readonly config = eventWorkerConfig();
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopped = false;

  constructor(
    @InjectModel('Post') private readonly posts: Model<any>,
    private readonly lifecycle: PostLifecycle,
  ) {}

  onModuleInit(): void {
    const poll = () =>
      void this.runOnce().catch((error) =>
        this.logger.failure(
          'expiration.poll',
          error,
          'EXPIRATION_POLL_FAILED',
          'Expiration scan failed',
          {},
          true,
        ),
      );
    this.timer = setInterval(poll, this.config.expirationPollMs);
    this.timer.unref();
    poll();
  }

  async runOnce(): Promise<void> {
    if (this.stopped) return;
    if (this.running) return this.running;
    this.running = this.expireBatch();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async expireBatch(): Promise<void> {
    const due = await this.posts
      .find(
        { status: 'ACTIVE', expiresAt: { $ne: null, $lte: new Date() } },
        'postId -_id',
      )
      .sort({ expiresAt: 1, postId: 1 })
      .limit(this.config.batchSize)
      .lean();
    for (const post of due) {
      if (this.stopped) break;
      try {
        await this.lifecycle.expire(post.postId);
      } catch (error) {
        this.logger.failure(
          'expiration.process',
          error,
          'EXPIRATION_FAILED',
          'Post expiration failed',
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
