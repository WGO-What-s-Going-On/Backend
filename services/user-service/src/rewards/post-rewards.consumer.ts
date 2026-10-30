import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { ActivityService } from './activity.service.js';
import {
  InvalidRewardEvent,
  ConflictingRewardEvent,
  UnsupportedRewardEvent,
  parsePostEvent,
} from './post-event.js';

export const POST_STREAM = 'post:events',
  REWARDS_GROUP = 'post-user-rewards',
  REWARDS_DLQ = 'user:post:dead';
type Entry = [string, string[]];
@Injectable()
export class PostRewardsConsumer
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(PostRewardsConsumer.name);
  readonly redis: Redis;
  readonly consumer = `user-${randomUUID()}`;
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  private cursor = '0-0';
  private readonly idle: number;
  private readonly attempts: number;
  private readonly pollMs: number;
  private readonly regionContract: 'none' | 'post-region-v1';
  constructor(
    config: ConfigService,
    private readonly activities: ActivityService,
  ) {
    this.idle = config.get<number>('rewards.pendingIdleMs') ?? 30000;
    this.attempts = config.get<number>('rewards.maxAttempts') ?? 5;
    this.pollMs = config.get<number>('rewards.pollIntervalMs') ?? 1000;
    this.regionContract =
      config.get<'none' | 'post-region-v1'>('rewards.regionContract') ?? 'none';
    this.redis = new Redis(config.getOrThrow<string>('redis.url'), {
      lazyConnect: true,
      enableOfflineQueue: false,
      connectTimeout: 2000,
      commandTimeout: 2000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
      autoResendUnfulfilledCommands: false,
    });
    this.redis.on('error', () => undefined);
  }
  onApplicationBootstrap(): void {
    this.timer = setInterval(() => void this.poll(), this.pollMs);
    this.timer.unref();
    void this.poll();
  }
  poll(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    this.running = this.pollOnce()
      .catch(() => {
        this.logger.warn(
          'Post rewards poll failed; pending deliveries will be retried',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  async pollOnce(): Promise<void> {
    if (this.redis.status === 'wait' || this.redis.status === 'end')
      await this.redis.connect();
    try {
      await this.redis.xgroup(
        'CREATE',
        POST_STREAM,
        REWARDS_GROUP,
        '0',
        'MKSTREAM',
      );
    } catch (e) {
      if (!String(e).includes('BUSYGROUP')) throw e;
    }
    const claimed = (await this.redis.xautoclaim(
      POST_STREAM,
      REWARDS_GROUP,
      this.consumer,
      this.idle,
      this.cursor,
      'COUNT',
      20,
    )) as [string, Entry[]];
    this.cursor = claimed[0];
    for (const entry of claimed[1]) await this.process(entry);
    const batches = (await this.redis.xreadgroup(
      'GROUP',
      REWARDS_GROUP,
      this.consumer,
      'COUNT',
      20,
      'STREAMS',
      POST_STREAM,
      '>',
    )) as Array<[string, Entry[]]> | null;
    for (const batch of batches ?? [])
      for (const entry of batch[1]) await this.process(entry);
  }
  async process([streamId, values]: Entry): Promise<void> {
    const fields: Record<string, string> = {};
    for (let i = 0; i < values.length; i += 2)
      fields[values[i]!] = values[i + 1]!;
    try {
      const event = parsePostEvent(fields, this.regionContract);
      if (event) await this.activities.record(event);
    } catch (error) {
      const pending = (await this.redis.xpending(
        POST_STREAM,
        REWARDS_GROUP,
        streamId,
        streamId,
        1,
      )) as Array<[string, string, number, number]>;
      if (
        !(error instanceof InvalidRewardEvent) &&
        (pending[0]?.[3] ?? 0) < this.attempts
      )
        return;
      // Quarantine and ACK are atomic. A crash cannot lose an invalid delivery between them.
      await this.redis.eval(
        `if redis.call('XPENDING',KEYS[1],ARGV[1],ARGV[2],ARGV[2],1)[1] then
        redis.call('XADD',KEYS[2],'*','streamId',ARGV[2],'eventId',ARGV[3],'data',ARGV[4],'reason',ARGV[5]);
        return redis.call('XACK',KEYS[1],ARGV[1],ARGV[2]); end; return 0`,
        2,
        POST_STREAM,
        REWARDS_DLQ,
        REWARDS_GROUP,
        streamId,
        fields.eventId ?? '',
        fields.data ?? '',
        error instanceof UnsupportedRewardEvent
          ? 'UNSUPPORTED_EVENT'
          : error instanceof ConflictingRewardEvent
            ? 'ACTIVITY_CONFLICT'
            : error instanceof InvalidRewardEvent
              ? 'INVALID_EVENT'
              : 'RETRY_EXHAUSTED',
      );
      return;
    }
    // ACK errors leave a committed inbox receipt; redelivery safely repeats this ACK.
    await this.redis.xack(POST_STREAM, REWARDS_GROUP, streamId);
  }
  async onModuleDestroy(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
    this.redis.disconnect();
  }
}
