import { createLogger } from '../observability/logging.js';
import {
  Injectable,
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
  private readonly logger = createLogger('moderation-service', 'reports');
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
      .catch((error) => {
        this.logger.failure(
          'report_recovery_failed',
          error,
          'REPORT_RECOVERY_FAILED',
          'Report publication failed; journal retained for retry',
          {},
          true,
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
        this.logger.success(
          'report_journal_reconciled',
          'Report journal recovery completed',
        );
      } catch (error) {
        this.logger.failure(
          'report_publication_failed',
          error,
          'REPORT_PUBLICATION_FAILED',
          'Report event publication failed; journal retained',
          {},
          true,
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
