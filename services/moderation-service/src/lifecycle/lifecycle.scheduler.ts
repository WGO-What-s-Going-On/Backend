import {
  Inject,
  Injectable,
  Logger,
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
  private readonly logger = new Logger(LifecycleScheduler.name);
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
        void this.scan().catch(() =>
          this.logger.warn(
            JSON.stringify({
              event: 'lifecycle_scan_failed',
              service: 'moderation-service',
            }),
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
        } catch {
          this.logger.warn(
            JSON.stringify({
              event: 'lifecycle_evaluation_failed',
              service: 'moderation-service',
              postId,
            }),
          );
        }
      }
    } finally {
      if (evaluated)
        this.logger.log(
          JSON.stringify({
            event: 'lifecycle_scan_completed',
            service: 'moderation-service',
            evaluated,
            durationMs: Math.round(performance.now() - started),
          }),
        );
    }
  }
}
