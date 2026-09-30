import { Injectable, Logger, type OnApplicationBootstrap, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import { RedisStreamsPublisher } from './redis-streams.publisher.js';

@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly pollIntervalMs: number;
  private readonly batchSize: number;
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;

  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly publisher: RedisStreamsPublisher,
    config: ConfigService,
  ) {
    this.pollIntervalMs = config.getOrThrow<number>('outbox.pollIntervalMs');
    this.batchSize = config.getOrThrow<number>('outbox.batchSize');
  }

  onApplicationBootstrap(): void {
    this.timer = setInterval(() => { void this.publishPending(); }, this.pollIntervalMs);
    this.timer.unref();
    void this.publishPending();
  }

  publishPending(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    // Catch DB/commit errors too: an interval callback must not reject unhandled or stop polling.
    this.running = this.publishBatch().catch(() => {
      this.logger.warn('Outbox batch failed; pending events will be retried');
    }).finally(() => { this.running = undefined; });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    this.publisher.close();
  }

  private async publishBatch(): Promise<void> {
    await this.dataSource.transaction(async (manager) => {
      const outbox = manager.getRepository(OutboxEventEntity);
      const events = await outbox.createQueryBuilder('event')
        .where('event.status = :status', { status: 'PENDING' })
        .orderBy('event.createdAt', 'ASC').addOrderBy('event.eventId', 'ASC')
        .take(this.batchSize).setLock('pessimistic_write').setOnLocked('skip_locked')
        .getMany();

      for (const event of events) {
        if (this.stopping) break;
        const envelope = event.payload;
        // Never reconstruct or silently fix a persisted event with inconsistent identity.
        if (envelope.eventId !== event.eventId || envelope.type !== event.eventType) {
          this.logger.warn(`Outbox ${event.eventId} has mismatched envelope identity; left pending`);
          continue;
        }
        try {
          await this.publisher.connect();
        } catch {
          // No XADD was attempted yet, so connection failures do not increment attempts.
          this.logger.warn('Outbox Redis connection unavailable; retry on next poll');
          break;
        }
        event.publishAttempts += 1;
        try {
          await this.publisher.publish(envelope);
          event.status = 'PUBLISHED';
          event.publishedAt = new Date();
        } catch {
          // Commit failed attempts as well; Redis failure must not mark an event published.
          this.logger.warn(`Outbox ${event.eventId} publish failed; retry on next poll`);
          await outbox.update(event.eventId, { publishAttempts: event.publishAttempts });
          // Avoid holding all batch locks for batchSize consecutive network timeouts.
          break;
        }
        // Locks span XADD through commit. If commit fails, this update AND attempt count
        // roll back, but Redis may already contain the event: retry with the SAME eventId.
        await outbox.update(event.eventId, {
          status: event.status, publishedAt: event.publishedAt, publishAttempts: event.publishAttempts,
        });
      }
    });
  }
}
