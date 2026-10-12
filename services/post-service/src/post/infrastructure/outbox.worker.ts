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
import { eventWorkerConfig } from './worker-config.js';
import {
  InvalidOutboxEvent,
  serializePostEvent,
} from './post-event-envelope.js';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly config = eventWorkerConfig();
  private timer?: NodeJS.Timeout;
  private running = false;
  private stopped = false;
  private publishing: Promise<void> = Promise.resolve();
  private wakeRequested = false;
  private readonly redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6380',
    disableOfflineQueue: true,
    socket: {
      reconnectStrategy: false,
      connectTimeout: this.config.redisTimeoutMs,
    },
  });

  constructor(@InjectModel('Outbox') private readonly outbox: Model<any>) {
    this.redis.on('error', (error: Error) =>
      this.logger.warn(`Redis: ${error.message}`),
    );
  }

  onModuleInit(): void {
    // 즉시 깨우기가 누락되거나 Redis가 잠시 실패한 경우를 위한 복구 폴링이다.
    this.timer = setInterval(() => {
      void this.publishPending().catch((error) =>
        this.logger.warn(`Outbox polling failed: ${String(error)}`),
      );
    }, this.config.pollMs);
    this.timer.unref();
  }

  wake(): void {
    if (this.stopped) return;
    // 요청 응답을 발행 작업이 기다리지 않도록 다음 이벤트 루프에서 처리한다.
    this.wakeRequested = true;
    setImmediate(() => {
      void this.publishPending().catch((error) =>
        this.logger.warn(`Outbox polling failed: ${String(error)}`),
      );
    });
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    // MongoDB 연결이 닫히기 전에 이미 선점한 이벤트의 저장·발행을 마친다.
    await this.publishing;
    if (this.redis.isOpen) this.redis.destroy();
  }

  async publishPending(): Promise<void> {
    if (this.stopped) return;
    if (this.running) {
      this.wakeRequested = true;
      await this.publishing;
      return;
    }
    this.running = true;
    let complete!: () => void;
    this.publishing = new Promise<void>((resolve) => {
      complete = resolve;
    });
    this.wakeRequested = false;
    try {
      for (
        let processed = 0;
        processed < this.config.batchSize && !this.stopped;
        processed++
      ) {
        const now = new Date();
        // 발행 시도마다 다른 토큰을 사용해 만료된 선점의 늦은 저장이 새 소유자를 덮지 못하게 한다.
        const claimToken = randomUUID();
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
                claimedBy: claimToken,
                claimedUntil: new Date(now.getTime() + this.config.leaseMs),
              },
              $inc: { attemptCount: 1, totalAttempts: 1 },
            },
            { sort: { createdAt: 1 }, new: true },
          )
          .lean();
        if (!event) break;
        try {
          // 마지막 시도 중 프로세스가 종료된 경우에도 선점을 회수한 뒤 격리한다.
          if (event.attemptCount > this.config.maxAttempts)
            throw new InvalidOutboxEvent(
              'Retry budget exhausted after abandoned claim',
            );
          const data = serializePostEvent(event);
          if (!this.redis.isOpen)
            await this.redisDeadline(this.redis.connect());
          const streamId = await this.redisDeadline(
            this.redis.xAdd('post:events', '*', {
              eventId: event.eventId,
              eventType: event.eventType,
              data,
            }),
          );
          if (!streamId) throw new Error('Redis did not return a Stream ID');
          this.logger.debug(
            `Published ${event.eventId}; outboxWaitMs=${Date.now() - event.createdAt.getTime()}`,
          );
          await this.outbox.updateOne(
            { _id: event._id, status: 'PUBLISHING', claimedBy: claimToken },
            {
              $set: {
                status: 'PUBLISHED',
                streamId,
                publishedAt: new Date(),
                claimedBy: null,
                claimedUntil: null,
                lastError: null,
                failedAt: null,
              },
            },
          );
        } catch (error) {
          // Redis 성공 후 DB 저장이 실패해도 같은 ID로 재시도한다. 정확히 한 번 전달은 보장하지 않는다.
          if (this.redis.isOpen) this.redis.destroy();
          const failed =
            error instanceof InvalidOutboxEvent ||
            event.attemptCount >= this.config.maxAttempts;
          const lastError = String(error).slice(0, 1000);
          this.logger.warn(
            `Publish ${event.eventId}: ${failed ? 'FAILED' : 'retry'}; ${lastError}`,
          );
          await this.outbox.updateOne(
            { _id: event._id, status: 'PUBLISHING', claimedBy: claimToken },
            {
              $set: {
                status: failed ? 'FAILED' : 'PENDING',
                lastError,
                failedAt: failed ? new Date() : null,
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
      complete();
      if (this.wakeRequested && !this.stopped) this.wake();
    }
  }

  private async redisDeadline<T>(work: Promise<T>): Promise<T> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        work,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => {
            // 단순 Promise timeout만 사용하면 이전 연결에서 명령이 뒤늦게 실행될 수 있다.
            if (this.redis.isOpen) this.redis.destroy();
            reject(new Error('Redis publish timeout; result may be unknown'));
          }, this.config.redisTimeoutMs);
        }),
      ]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
