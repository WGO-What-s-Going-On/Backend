import {
  createLogger,
  withLogContext,
  type LogFields,
} from '../../observability/logging.js';
import { InjectModel } from '@nestjs/mongoose';
import type { Model } from 'mongoose';
import {
  ConsoleLogger,
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { createClient } from 'redis';
import { PostNotFoundError } from '../domain/post.js';
import type { ContentDecision } from '../application/content-decision.js';
import { ApplyContentDecision } from '../application/content-decision.js';
import {
  InvalidContentDecision,
  parseContentDecision,
} from './content-decision-event.js';

type Redis = ReturnType<typeof createClient>;
type Entry = { id: string; message: Record<string, string> };
export const CONTENT_DECISION_STREAM = 'moderation:content-decisions';
export const CONTENT_DECISION_GROUP = 'post-content-enforcement';
export const CONTENT_DECISION_DEAD_STREAM = 'post-content-enforcement:dead';

const moderationLog = createLogger('post-service', 'moderation');
function logModerationFailure(fields: LogFields): void {
  moderationLog.failure(
    String(fields.event),
    undefined,
    String(fields.errorCode),
    'Moderation event processing failed',
    { ...fields, consumerGroup: CONTENT_DECISION_GROUP },
    fields.disposition === 'RETRY',
  );
}

export class ContentDecisionConsumer {
  readonly name = `post-${randomUUID()}`;
  private cursor = '0-0';
  constructor(
    readonly redis: Redis,
    private readonly application: Pick<ApplyContentDecision, 'execute'>,
    private readonly reclaimMs = 30000,
    private readonly stream = CONTENT_DECISION_STREAM,
    private readonly logger: Pick<ConsoleLogger, 'warn' | 'error'> = {
      warn: logModerationFailure,
      error: logModerationFailure,
    },
  ) {}

  private commands() {
    return this.redis.withCommandOptions({ timeout: 2000 });
  }

  async initialize(): Promise<void> {
    try {
      await this.commands().xGroupCreate(
        this.stream,
        CONTENT_DECISION_GROUP,
        '0',
        {
          MKSTREAM: true,
        },
      );
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  async tick(): Promise<void> {
    // 지연된 실패 메시지는 30초 이상 뒤에 회수한다. 큰 배치로 신규 이벤트를 굶기지 않는다.
    const claimed = await this.commands().xAutoClaim(
      this.stream,
      CONTENT_DECISION_GROUP,
      this.name,
      this.reclaimMs,
      this.cursor,
      { COUNT: 10 },
    );
    this.cursor = claimed.nextId;
    for (const entry of claimed.messages) if (entry) await this.process(entry);
    const batches = (await this.commands().xReadGroup(
      CONTENT_DECISION_GROUP,
      this.name,
      { key: this.stream, id: '>' },
      { COUNT: 10 },
    )) as Array<{ messages: Entry[] }> | null;
    for (const batch of batches ?? [])
      for (const entry of batch.messages) await this.process(entry);
  }

  async process(entry: Entry): Promise<void> {
    let input: ContentDecision | null = null;
    let deadLettered = false;
    // 손상된 payload나 예외 본문을 로그에 펼치지 않고 식별자만 명시적으로 선택한다.
    const context = () => ({
      service: 'post-service',
      stream: this.stream,
      consumerGroup: CONTENT_DECISION_GROUP,
      consumer: this.name,
      streamId: entry.id,
      eventId:
        input?.eventId ??
        (/^evt_[0-9a-f-]{36}$/.test(entry.message.eventId ?? '')
          ? entry.message.eventId
          : undefined),
      postId: input?.postId,
      correlationId: input?.correlationId,
    });
    try {
      input = parseContentDecision(entry.message);
      if (input) {
        const parsed = input;
        await withLogContext({ correlationId: parsed.correlationId }, () =>
          this.application.execute(parsed),
        );
      }
    } catch (error) {
      const errorCode =
        error instanceof InvalidContentDecision
          ? 'INVALID_CONTRACT'
          : error instanceof PostNotFoundError
            ? 'POST_NOT_FOUND'
            : 'PROCESSING_FAILED';
      let attempt: number;
      try {
        const pending = await this.commands().xPendingRange(
          this.stream,
          CONTENT_DECISION_GROUP,
          entry.id,
          entry.id,
          1,
        );
        attempt = pending[0]?.deliveriesCounter ?? 1;
      } catch (pendingError) {
        this.logger.error({
          ...context(),
          event: 'moderation_event_retry',
          errorCode: 'PENDING_LOOKUP_FAILED',
          causeCode: errorCode,
          attempt: null,
          disposition: 'RETRY',
        });
        throw pendingError;
      }
      if (!(error instanceof InvalidContentDecision) && attempt < 5) {
        this.logger.warn({
          ...context(),
          event: 'moderation_event_retry',
          errorCode,
          attempt,
          disposition: 'RETRY',
        });
        return;
      }
      // DLQ 저장이 성공했을 때만 격리 완료를 기록한다. 저장 실패에는 ACK하지 않는다.
      try {
        await this.commands().xAdd(CONTENT_DECISION_DEAD_STREAM, '*', {
          streamId: entry.id,
          eventId: entry.message.eventId ?? '',
          error:
            error instanceof InvalidContentDecision
              ? 'INVALID_CONTRACT'
              : 'RETRY_EXHAUSTED',
          original: JSON.stringify(entry.message),
        });
      } catch (deadLetterError) {
        this.logger.error({
          ...context(),
          event: 'moderation_event_dlq_failed',
          errorCode: 'DLQ_WRITE_FAILED',
          causeCode: errorCode,
          attempt,
          disposition: 'RETRY',
        });
        throw deadLetterError;
      }
      deadLettered = true;
      this.logger.warn({
        ...context(),
        event: 'moderation_event_dead_lettered',
        errorCode,
        attempt,
        disposition: 'DLQ',
        reason:
          error instanceof InvalidContentDecision
            ? 'INVALID_CONTRACT'
            : 'RETRY_EXHAUSTED',
      });
    }
    // ACK 실패는 업무 실패 재시도 예산과 분리한다. 재전달 시 MongoDB 처리 이력이 중복을 막는다.
    try {
      await this.commands().xAck(this.stream, CONTENT_DECISION_GROUP, entry.id);
      if (deadLettered)
        moderationLog.success(
          'moderation.dead_lettered',
          'Moderation event saved to dead letter stream and acknowledged',
          context(),
        );
      else if (input)
        moderationLog.success(
          'moderation.event_processed',
          'Moderation event processing completed and acknowledged',
          context(),
        );
      else
        moderationLog.skipped(
          'moderation.event_processed',
          'EVENT_NOT_SUPPORTED',
          context(),
        );
    } catch (error) {
      this.logger.error({
        ...context(),
        event: 'moderation_event_ack_failed',
        errorCode: 'ACK_FAILED',
        disposition: 'RETRY',
      });
      throw error;
    }
  }
}

@Injectable()
export class ContentDecisionWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = createLogger('post-service', 'moderation');
  private stopped = false;
  private running?: Promise<void>;
  private redis?: Redis;
  constructor(
    private readonly application: ApplyContentDecision,
    @InjectModel('ModerationReceipt')
    private readonly receipts: Model<{ eventId: string }>,
  ) {}

  onModuleInit(): void {
    const enabled =
      process.env.POST_CONTENT_DECISION_CONSUMER_ENABLED ?? 'false';
    if (!['true', 'false'].includes(enabled))
      throw new Error('Invalid POST_CONTENT_DECISION_CONSUMER_ENABLED');
    if (enabled === 'false') return;
    if (
      process.env.MODERATION_CONTENT_DECISION_STREAM !== undefined &&
      !process.env.MODERATION_CONTENT_DECISION_STREAM.trim()
    )
      throw new Error('Invalid MODERATION_CONTENT_DECISION_STREAM');
    // Moderation과 Post는 로컬 Redis endpoint도 다르다. Post REDIS_URL로 자동 대체하지 않는다.
    const url = process.env.MODERATION_REDIS_URL;
    if (!url || !['redis:', 'rediss:'].includes(new URL(url).protocol))
      throw new Error('MODERATION_REDIS_URL required');
    const stream =
      process.env.MODERATION_CONTENT_DECISION_STREAM ?? CONTENT_DECISION_STREAM;
    if (
      [
        'post:events',
        'moderation:events',
        'moderation:content-events',
        'moderation:report-events',
        CONTENT_DECISION_DEAD_STREAM,
        process.env.MODERATION_EVENT_STREAM,
        process.env.POST_EVENT_STREAM,
        process.env.MODERATION_CONTENT_EVENT_STREAM,
        process.env.MODERATION_REPORT_EVENT_STREAM,
      ].includes(stream)
    )
      throw new Error('Content decision stream must be independent');
    this.redis = createClient({
      url,
      disableOfflineQueue: true,
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.redis.on('error', (error) =>
      this.logger.failure(
        'moderation.redis',
        error,
        'REDIS_CONNECTION_FAILED',
        'Moderation Redis connection failed',
        {},
        true,
      ),
    );
    this.running = this.run(this.redis);
  }

  private async run(redis: Redis): Promise<void> {
    const consumer = new ContentDecisionConsumer(
      redis,
      this.application,
      30000,
      process.env.MODERATION_CONTENT_DECISION_STREAM ?? CONTENT_DECISION_STREAM,
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
      } catch (error) {
        this.logger.failure(
          'moderation.poll',
          error,
          'MODERATION_POLL_FAILED',
          'Moderation event polling failed',
          {},
          true,
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
