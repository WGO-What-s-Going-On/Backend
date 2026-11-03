import { createLogger } from '../observability/logging.js';
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { CLOCK, type Clock } from './clock.js';
import { LifecycleService } from './lifecycle.service.js';

const INTERVAL_MS = 1000;

@Injectable()
export class LifecycleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('moderation-service', 'lifecycle');
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private scanning: Promise<void> = Promise.resolve();

  constructor(
    private readonly lifecycle: LifecycleService,
    @Inject(CLOCK) private readonly clock: Clock,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    if (this.config && !this.config.get<string>('redis.url')) return;
    this.timer = setInterval(
      () =>
        void this.scan().catch((error) =>
          this.logger.failure(
            'lifecycle_scan_failed',
            error,
            'LIFECYCLE_SCAN_FAILED',
            'lifecycle scan failed',
            {},
            true,
          ),
        ),
      INTERVAL_MS,
    );
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    await this.scanning.catch(() => undefined);
  }

  async scan(): Promise<void> {
    if (this.running || this.stopped) return;
    this.running = true;
    this.scanning = this.run().finally(() => {
      this.running = false;
    });
    return this.scanning;
  }

  private async run(): Promise<void> {
    const started = performance.now();
    let evaluated = 0;
    try {
      const now = this.clock.now();
      for (const postId of await this.lifecycle.due(now)) {
        if (this.stopped) break;
        try {
          await this.lifecycle.evaluate(postId, now);
          evaluated++;
        } catch (error) {
          this.logger.failure(
            'lifecycle_evaluation_failed',
            error,
            'LIFECYCLE_EVALUATION_FAILED',
            'lifecycle evaluation failed',
            {
              postId,
            },
            true,
          );
        }
      }
    } finally {
      if (evaluated)
        this.logger.success(
          'lifecycle_scan_completed',
          'lifecycle scan completed',
          {
            count: evaluated,
            durationMs: Math.round(performance.now() - started),
          },
        );
    }
  }
}
