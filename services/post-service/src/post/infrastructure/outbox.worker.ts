import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { randomUUID } from 'node:crypto';
import { Model } from 'mongoose';
import { createClient } from 'redis';

@Injectable()
export class OutboxWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(OutboxWorker.name);
  private readonly workerId = randomUUID();
  private timer?: NodeJS.Timeout;
  private running = false;
  private readonly redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6380',
    socket: { reconnectStrategy: false, connectTimeout: 2000 },
  });

  constructor(@InjectModel('Outbox') private readonly outbox: Model<any>) {
    this.redis.on('error', (error: Error) => this.logger.warn(`Redis: ${error.message}`));
  }

  onModuleInit(): void {
    this.timer = setInterval(() => { void this.publishPending(); }, 1000);
    this.timer.unref();
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    if (this.redis.isOpen) await this.redis.quit();
  }

  async publishPending(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const now = new Date();
      const event = await this.outbox.findOneAndUpdate({
        $or: [
          { status: 'PENDING', nextAttemptAt: { $lte: now } },
          { status: 'PUBLISHING', claimedUntil: { $lte: now } },
        ],
      }, { $set: { status: 'PUBLISHING', claimedBy: this.workerId, claimedUntil: new Date(now.getTime() + 30000) }, $inc: { attemptCount: 1 } }, { sort: { createdAt: 1 }, new: true }).lean();
      if (!event) return;
      try {
        if (!this.redis.isOpen) await this.redis.connect();
        const envelope = {
          eventId: event.eventId, eventType: event.eventType,
          schemaVersion: event.schemaVersion, producer: event.producer,
          aggregateId: event.aggregateId, correlationId: event.correlationId,
          occurredAt: event.occurredAt.toISOString(), ...event.payload,
        };
        const streamId = await this.redis.xAdd('post:events', '*', { eventId: event.eventId, eventType: event.eventType, data: JSON.stringify(envelope) });
        await this.outbox.updateOne({ _id: event._id, status: 'PUBLISHING', claimedBy: this.workerId }, { $set: { status: 'PUBLISHED', streamId, publishedAt: new Date(), claimedBy: null, claimedUntil: null } });
      } catch (error) {
        this.logger.warn(`Publish ${event.eventId} failed: ${String(error)}`);
        await this.outbox.updateOne({ _id: event._id, status: 'PUBLISHING', claimedBy: this.workerId }, { $set: { status: 'PENDING', claimedBy: null, claimedUntil: null, nextAttemptAt: new Date(Date.now() + Math.min(60000, 1000 * 2 ** Math.min(event.attemptCount, 6))) } });
      }
    } finally {
      this.running = false;
    }
  }
}
