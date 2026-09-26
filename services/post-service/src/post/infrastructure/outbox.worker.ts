import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import type { Model } from 'mongoose';
import { createClient } from 'redis';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private running = false;
  private wakeRequested = false;
  private readonly redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6380',
    socket: { reconnectStrategy: false, connectTimeout: 2000 },
  });

  constructor(@InjectModel('Outbox') private readonly outbox: Model<any>) {
    this.redis.on('error', (error: Error) =>
      this.logger.warn(`Redis: ${error.message}`),
    );
  }

  onModuleInit(): void {
    // 즉시 깨우기가 누락되거나 Redis가 잠시 실패한 경우를 위한 복구 폴링이다.
    this.timer = setInterval(() => {
      void this.publishPending();
    }, 1000);
    this.timer.unref();
  }

  wake(): void {
    // 요청 응답을 발행 작업이 기다리지 않도록 다음 이벤트 루프에서 처리한다.
    this.wakeRequested = true;
    setImmediate(() => {
      void this.publishPending();
    });
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.redis.isOpen) await this.redis.quit();
  }

  async publishPending(): Promise<void> {
    if (this.running) {
      this.wakeRequested = true;
      return;
    }
    this.running = true;
    this.wakeRequested = false;
    try {
      while (true) {
        const now = new Date();
        // 원자적으로 선점하므로 여러 Worker가 떠 있어도 한 번에 하나만 발행을 시도한다.
        // 선점 중 죽은 Worker의 이벤트는 claimedUntil 이후 다시 가져온다.
        const event = await this.outbox
          .findOneAndUpdate(
            {
              $or: [
                { status: 'PENDING', nextAttemptAt: { $lte: now } },
                { status: 'PUBLISHING', claimedUntil: { $lte: now } },
              ],
            },
            {
              $set: {
                status: 'PUBLISHING',
                claimedBy: this.workerId,
                claimedUntil: new Date(now.getTime() + 30000),
              },
              $inc: { attemptCount: 1 },
            },
            { sort: { createdAt: 1 }, new: true },
          )
          .lean();
        if (!event) break;
        try {
          if (!this.redis.isOpen) await this.redis.connect();
          const envelope = {
            eventId: event.eventId,
            eventType: event.eventType,
            schemaVersion: event.schemaVersion,
            producer: event.producer,
            aggregateId: event.aggregateId,
            correlationId: event.correlationId,
            occurredAt: event.occurredAt.toISOString(),
            ...event.payload,
          };
          const streamId = await this.redis.xAdd('post:events', '*', {
            eventId: event.eventId,
            eventType: event.eventType,
            data: JSON.stringify(envelope),
          });
          this.logger.debug(
            `Published ${event.eventId}; outboxWaitMs=${Date.now() - event.createdAt.getTime()}`,
          );
          await this.outbox.updateOne(
            { _id: event._id, status: 'PUBLISHING', claimedBy: this.workerId },
            {
              $set: {
                status: 'PUBLISHED',
                streamId,
                publishedAt: new Date(),
                claimedBy: null,
                claimedUntil: null,
              },
            },
          );
        } catch (error) {
          // 재시도 시 eventId는 그대로 유지한다. 소비자는 이 ID로 중복을 제거한다.
          this.logger.warn(`Publish ${event.eventId} failed: ${String(error)}`);
          await this.outbox.updateOne(
            { _id: event._id, status: 'PUBLISHING', claimedBy: this.workerId },
            {
              $set: {
                status: 'PENDING',
                claimedBy: null,
                claimedUntil: null,
                nextAttemptAt: new Date(
                  Date.now() +
                    Math.min(
                      60000,
                      1000 * 2 ** Math.min(event.attemptCount, 6),
                    ),
                ),
              },
            },
          );
        }
      }
    } finally {
      this.running = false;
      if (this.wakeRequested) this.wake();
    }
  }
}
