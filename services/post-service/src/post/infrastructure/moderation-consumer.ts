import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  Injectable,
  Logger,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { ApplyModerationLifecycle } from '../application/moderation.js';
import {
  InvalidModerationEvent,
  parseModerationEvent,
} from './moderation-event.js';

type Redis = ReturnType<typeof createClient>;
type Entry = { id: string; message: Record<string, string> };
export const MODERATION_STREAM = 'moderation:events';
export const MODERATION_GROUP = 'post-moderation-lifecycle';
export const MODERATION_DEAD_STREAM = 'post-moderation-lifecycle:dead';

export class ModerationConsumer {
  readonly name = `post-${randomUUID()}`;
  private cursor = '0-0';
  constructor(
    readonly redis: Redis,
    private readonly application: Pick<ApplyModerationLifecycle, 'execute'>,
    private readonly reclaimMs = 30000,
    private readonly stream = MODERATION_STREAM,
  ) {}

  private commands() {
    return this.redis.withCommandOptions({ timeout: 2000 });
  }

  async initialize(): Promise<void> {
    try {
      await this.commands().xGroupCreate(this.stream, MODERATION_GROUP, '0', {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  async tick(): Promise<void> {
    // 지연된 실패 메시지는 30초 이상 뒤에 회수한다. 큰 배치로 신규 이벤트를 굶기지 않는다.
    const claimed = await this.commands().xAutoClaim(
      this.stream,
      MODERATION_GROUP,
      this.name,
      this.reclaimMs,
      this.cursor,
      { COUNT: 10 },
    );
    this.cursor = claimed.nextId;
    for (const entry of claimed.messages) if (entry) await this.process(entry);
    const batches = (await this.commands().xReadGroup(
      MODERATION_GROUP,
      this.name,
      { key: this.stream, id: '>' },
      { COUNT: 10 },
    )) as Array<{ messages: Entry[] }> | null;
    for (const batch of batches ?? [])
      for (const entry of batch.messages) await this.process(entry);
  }

  async process(entry: Entry): Promise<void> {
    try {
      const input = parseModerationEvent(entry.message);
      if (input) await this.application.execute(input);
    } catch (error) {
      const pending = await this.commands().xPendingRange(
        this.stream,
        MODERATION_GROUP,
        entry.id,
        entry.id,
        1,
      );
      if (
        !(error instanceof InvalidModerationEvent) &&
        (pending[0]?.deliveriesCounter ?? 1) < 5
      )
        return;
      // DB 오류 상세는 공개하지 않는다. 원문은 접근 제한된 DLQ에 보존하며 저장 실패 시 ACK하지 않는다.
      await this.commands().xAdd(MODERATION_DEAD_STREAM, '*', {
        streamId: entry.id,
        eventId: entry.message.eventId ?? '',
        error:
          error instanceof InvalidModerationEvent
            ? 'INVALID_CONTRACT'
            : 'RETRY_EXHAUSTED',
        original: JSON.stringify(entry.message),
      });
    }
    // ACK 실패는 업무 실패 재시도 예산과 분리한다. 재전달 시 MongoDB 처리 이력이 중복을 막는다.
    await this.commands().xAck(this.stream, MODERATION_GROUP, entry.id);
  }
}

@Injectable()
export class ModerationWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ModerationWorker.name);
  private stopped = false;
  private running?: Promise<void>;
  private redis?: Redis;
  constructor(
    private readonly application: ApplyModerationLifecycle,
    @InjectModel('ModerationReceipt') private readonly receipts: Model<any>,
  ) {}

  onModuleInit(): void {
    const enabled = process.env.POST_MODERATION_CONSUMER_ENABLED ?? 'false';
    if (!['true', 'false'].includes(enabled))
      throw new Error('Invalid POST_MODERATION_CONSUMER_ENABLED');
    if (enabled === 'false') return;
    if (
      process.env.MODERATION_EVENT_STREAM !== undefined &&
      !process.env.MODERATION_EVENT_STREAM.trim()
    )
      throw new Error('Invalid MODERATION_EVENT_STREAM');
    // Moderation과 Post는 로컬 Redis endpoint도 다르다. Post REDIS_URL로 자동 대체하지 않는다.
    const url = process.env.MODERATION_REDIS_URL;
    if (!url || !['redis:', 'rediss:'].includes(new URL(url).protocol))
      throw new Error('MODERATION_REDIS_URL required');
    this.redis = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.redis.on('error', () =>
      this.logger.warn('Moderation Redis connection error'),
    );
    this.running = this.run(this.redis);
  }

  private async run(redis: Redis): Promise<void> {
    const consumer = new ModerationConsumer(
      redis,
      this.application,
      30000,
      process.env.MODERATION_EVENT_STREAM ?? MODERATION_STREAM,
    );
    while (!this.stopped) {
      try {
        // 고유 인덱스가 준비되기 전에는 동시 소비를 시작하지 않는다.
        await this.receipts.init();
        if (!redis.isOpen) await redis.connect();
        await consumer.initialize();
        while (!this.stopped) {
          await consumer.tick();
          await delay(250);
        }
      } catch {
        this.logger.warn(
          'Moderation consumer retry; inspect pending entries and DLQ',
        );
        if (redis.isOpen) redis.destroy();
        if (!this.stopped) await delay(1000);
      }
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    await this.running;
    if (this.redis?.isOpen) this.redis.destroy();
  }
}
