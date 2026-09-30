import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export const USER_EVENTS_STREAM = 'user:events';

@Injectable()
export class RedisStreamsPublisher {
  private readonly redis: Redis;

  constructor(config: ConfigService) {
    const url = config.getOrThrow<string>('redis.url');
    const timeout = config.getOrThrow<number>('outbox.redisTimeoutMs');
    // Same endpoint as auth for now, but an independent connection bounds publisher I/O
    // without changing session behavior. Only polling retries XADD, not the Redis client.
    this.redis = new Redis(url, {
      lazyConnect: true, connectTimeout: timeout, commandTimeout: timeout,
      enableOfflineQueue: false, maxRetriesPerRequest: 0,
      autoResendUnfulfilledCommands: false, retryStrategy: () => null,
    });
    this.redis.on('error', () => undefined);
  }

  async connect(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end') await this.redis.connect();
  }

  async publish(envelope: Record<string, unknown>): Promise<void> {
    const streamId = await this.redis.xadd(USER_EVENTS_STREAM, '*',
      'eventId', envelope.eventId as string, 'eventType', envelope.type as string,
      'data', JSON.stringify(envelope));
    if (!streamId) throw new Error('Redis did not return a Stream ID');
  }

  close(): void {
    // The worker drains its in-flight batch before closing this dedicated connection.
    this.redis.disconnect();
  }
}
