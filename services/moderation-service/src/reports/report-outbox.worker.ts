import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ReportStore } from './report.store.js';

// Keep background recovery: committed events reach the stream even when a client
// does not retry an ambiguous/failed request. SQL polling is no longer involved.
@Injectable()
export class ReportOutboxWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReportOutboxWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  private cursor = '0';
  private pending: string[] = [];
  constructor(private readonly store: ReportStore) {}
  onApplicationBootstrap(): void {
    if (!this.store.configured) return;
    this.timer = setInterval(() => {
      void this.publishPending();
    }, 1000);
    this.timer.unref();
    void this.publishPending();
  }
  publishPending(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    this.running ??= this.publishBatch()
      .catch(() => {
        this.logger.warn(
          'Report publication unavailable; Redis journal retained for retry',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async publishBatch(): Promise<void> {
    if (!this.pending.length) {
      const batch = await this.store.pending(this.cursor);
      this.cursor = batch.cursor;
      this.pending = batch.members;
    }
    // Buffer SSCAN overflow so a bounded tick does not discard unvisited work.
    for (const digest of this.pending.splice(0, 20)) {
      if (this.stopping) break;
      try {
        await this.store.recover(digest);
      } catch {
        this.logger.warn(
          'Report event publication failed; pending journal retained',
        );
      }
    }
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
