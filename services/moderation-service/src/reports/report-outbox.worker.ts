import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { ReportStore } from './report.store.js';

@Injectable()
export class ReportOutboxWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(ReportOutboxWorker.name);
  private readonly redis;
  private readonly stream: string;
  private readonly enabled: boolean;
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  constructor(
    private readonly store: ReportStore,
    config: ConfigService,
  ) {
    const url = config.get<string>('redis.url');
    this.enabled = !!url && store.configured;
    this.stream =
      config.get<string>('reports.eventStream') ?? 'moderation:report-events';
    if (
      [
        config.get<string>('redis.postEventStream') ?? 'post:events',
        config.get<string>('redis.moderationEventStream') ??
          'moderation:events',
        config.get<string>('redis.contentEventStream') ??
          'moderation:content-events',
      ].includes(this.stream)
    )
      throw new Error('Report events require a separate stream');
    this.redis = createClient({
      url: url ?? 'redis://localhost:6383',
      disableOfflineQueue: true,
      commandOptions: { timeout: 2000 },
      commandsQueueMaxLength: 100,
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.redis.on('error', () => undefined);
  }
  onApplicationBootstrap(): void {
    if (!this.enabled) return;
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
          'Report outbox unavailable; pending events retained for retry',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async publishBatch(): Promise<void> {
    await this.store.transaction(async (client) => {
      // A later transition for a report cannot overtake its unpublished predecessor,
      // even when multiple ECS workers poll with SKIP LOCKED.
      const pending = await client.query<{
        sequence: string;
        event_id: string;
        event_type: string;
        envelope: Record<string, unknown>;
      }>(`
        SELECT o.* FROM moderation_report_outbox o WHERE o.published_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM moderation_report_outbox earlier WHERE earlier.report_id=o.report_id AND earlier.sequence<o.sequence AND earlier.published_at IS NULL)
        ORDER BY o.sequence LIMIT 20 FOR UPDATE OF o SKIP LOCKED`);
      for (const row of pending.rows) {
        if (this.stopping) break;
        if (
          row.envelope.eventId !== row.event_id ||
          row.envelope.eventType !== row.event_type
        ) {
          this.logger.warn('Report outbox identity mismatch; event retained');
          continue;
        }
        try {
          if (!this.redis.isReady) await this.redis.connect();
          await this.redis.xAdd(this.stream, '*', {
            eventId: row.event_id,
            eventType: row.event_type,
            data: JSON.stringify(row.envelope),
          });
        } catch {
          await client.query(
            'UPDATE moderation_report_outbox SET attempts=attempts+1 WHERE sequence=$1',
            [row.sequence],
          );
          this.logger.warn(
            'Report event publication failed; pending event retained',
          );
          break;
        }
        // An ambiguous XADD or failed SQL commit may replay the same eventId.
        await client.query(
          'UPDATE moderation_report_outbox SET published_at=now(), attempts=attempts+1 WHERE sequence=$1',
          [row.sequence],
        );
      }
    });
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    if (this.redis.isOpen) await this.redis.quit();
  }
}
