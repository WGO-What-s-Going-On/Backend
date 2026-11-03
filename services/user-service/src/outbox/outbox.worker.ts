import { createLogger } from '../observability/logging.js';
import {
  Injectable,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import { RedisStreamsPublisher } from './redis-streams.publisher.js';

@Injectable()
export class OutboxWorker implements OnApplicationBootstrap, OnModuleDestroy {
  private readonly logger = createLogger('user-service', 'outbox');
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
    this.timer = setInterval(() => {
      void this.publishPending();
    }, this.pollIntervalMs);
    this.timer.unref();
    void this.publishPending();
  }

  publishPending(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    // Catch DB/commit errors too: an interval callback must not reject unhandled or stop polling.
    this.running = this.publishBatch()
      .catch((error) => {
        this.logger.failure(
          'outbox_batch_failed',
          error,
          'OUTBOX_BATCH_FAILED',
          'Outbox batch failed; pending events will be retried',
          {},
          true,
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }

  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    this.publisher.close();
  }

  private async publishBatch(): Promise<void> {
    const published = await this.dataSource.transaction(async (manager) => {
      const committed: Array<{
        eventId: string;
        eventType: string;
        attempt: number;
        correlationId: unknown;
      }> = [];
      const outbox = manager.getRepository(OutboxEventEntity);
      const events = await outbox
        .createQueryBuilder('event')
        .where('event.status = :status', { status: 'PENDING' })
        .orderBy('event.createdAt', 'ASC')
        .addOrderBy('event.eventId', 'ASC')
        .take(this.batchSize)
        .setLock('pessimistic_write')
        .setOnLocked('skip_locked')
        .getMany();

      for (const event of events) {
        if (this.stopping) break;
        const envelope = event.payload;
        // Never reconstruct or silently fix a persisted event with inconsistent identity.
        if (
          envelope.eventId !== event.eventId ||
          envelope.type !== event.eventType
        ) {
          this.logger.failure(
            'outbox_identity_invalid',
            undefined,
            'OUTBOX_IDENTITY_INVALID',
            'Outbox envelope identity mismatch; left pending',
            { eventId: event.eventId },
          );
          continue;
        }
        try {
          await this.publisher.connect();
        } catch (error) {
          // No XADD was attempted yet, so connection failures do not increment attempts.
          this.logger.failure(
            'outbox_connection_failed',
            error,
            'REDIS_UNAVAILABLE',
            'Outbox Redis connection unavailable',
            {},
            true,
          );
          break;
        }
        event.publishAttempts += 1;
        try {
          await this.publisher.publish(envelope);
          event.status = 'PUBLISHED';
          event.publishedAt = new Date();
        } catch (error) {
          // Commit failed attempts as well; Redis failure must not mark an event published.
          this.logger.failure(
            'outbox_publish_failed',
            error,
            'OUTBOX_PUBLISH_FAILED',
            'Outbox event publication failed; retry on next poll',
            { eventId: event.eventId, attempt: event.publishAttempts },
            true,
          );
          await outbox.update(event.eventId, {
            publishAttempts: event.publishAttempts,
          });
          // Avoid holding all batch locks for batchSize consecutive network timeouts.
          break;
        }
        // Locks span XADD through commit. If commit fails, this update AND attempt count
        // roll back, but Redis may already contain the event: retry with the SAME eventId.
        await outbox.update(event.eventId, {
          status: event.status,
          publishedAt: event.publishedAt,
          publishAttempts: event.publishAttempts,
        });
        committed.push({
          eventId: event.eventId,
          eventType: event.eventType,
          attempt: event.publishAttempts,
          correlationId: envelope.correlationId,
        });
      }
      return committed;
    });
    for (const event of published)
      this.logger.success(
        'outbox_published',
        'Event publication committed',
        event,
      );
  }
}
