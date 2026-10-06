import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';

import { CLOCK, type Clock } from './clock.js';
import { LifecycleService } from './lifecycle.service.js';

const INTERVAL_MS = 10 * 60 * 1000;

@Injectable()
export class LifecycleScheduler implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(LifecycleScheduler.name);
  private timer?: NodeJS.Timeout;
  private running = false;

  constructor(
    private readonly lifecycle: LifecycleService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  onModuleInit(): void {
    this.timer = setInterval(
      () => void this.scan().catch((error) => this.logger.warn(error)),
      INTERVAL_MS,
    );
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async scan(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = this.clock.now();
      for (const projection of await this.lifecycle.list()) {
        try {
          await this.lifecycle.evaluate(projection.postId, now);
        } catch (error) {
          this.logger.warn({ postId: projection.postId, error });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
