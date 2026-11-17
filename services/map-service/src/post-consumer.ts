import { createLogger } from './observability/logging.js';
const log = createLogger('map-service', 'map');
import { randomUUID } from 'node:crypto';
import {
  DEAD_STREAM,
  POST_GROUP,
  POST_STREAM,
  PostIndex,
  parsePostCreated,
  parsePostStatus,
} from './post-index.js';

type Entry = { id: string; message: Record<string, string> };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export class PostConsumer {
  private readonly name = `map-${randomUUID()}`;
  private stopped = false;
  private failures = 0;
  private lastMetrics = 0;
  private reader?: ReturnType<PostIndex['redis']['duplicate']>;
  private running?: Promise<void>;
  constructor(private readonly index: PostIndex) {}

  async initialize(): Promise<void> {
    try {
      await this.index.redis.xGroupCreate(POST_STREAM, POST_GROUP, '0', {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // Abort a blocked read/reconnect without interrupting writes or ACKs on index.redis.
    if (this.reader?.isOpen) this.reader.destroy();
    await this.running?.catch(() => undefined);
  }

  async metrics(): Promise<{
    pending: number;
    oldestIdleMs: number;
    failures: number;
    deadLetters: number;
  }> {
    const pending = await this.index.redis.xPending(POST_STREAM, POST_GROUP);
    let oldestIdleMs = 0;
    let start = '-';
    while (true) {
      const page = await this.index.redis.xPendingRange(
        POST_STREAM,
        POST_GROUP,
        start,
        '+',
        100,
      );
      for (const entry of page)
        oldestIdleMs = Math.max(
          oldestIdleMs,
          Number(entry.millisecondsSinceLastDelivery),
        );
      if (page.length < 100) break;
      start = `(${page.at(-1)!.id}`;
    }
    return {
      pending: Number(pending.pending),
      oldestIdleMs,
      failures: this.failures,
      deadLetters: await this.index.redis.xLen(DEAD_STREAM),
    };
  }

  run(): Promise<void> {
    if (this.running) return this.running;
    if (this.stopped) return Promise.resolve();
    this.running = this.poll();
    return this.running;
  }

  private async poll(): Promise<void> {
    // BLOCK holds its socket. Keep searches, claims, ACKs and DLQ on index.redis.
    const reader = this.index.redis.duplicate({
      name: `${this.name}-reader`,
      disableOfflineQueue: true,
    });
    this.reader = reader;
    reader.on('error', (error) => {
      if (!this.stopped)
        log.failure(
          'consumer.reader.failed',
          error,
          'STREAM_READ_FAILED',
          'Map blocking reader connection failed.',
          { consumerGroup: POST_GROUP },
          true,
        );
    });
    try {
      await reader.connect();
      if (this.stopped) return;
      await this.initialize();
      while (!this.stopped) {
        try {
          // 먼저 중단된 배달을 회수하고, 이후 신규 이벤트를 같은 그룹의 다른 소비자와 나눈다.
          const claimed = await this.index.redis.xAutoClaim(
            POST_STREAM,
            POST_GROUP,
            this.name,
            1000,
            '0-0',
            { COUNT: 20 },
          );
          for (const entry of claimed.messages)
            if (entry) await this.process(entry);
          if (this.stopped) break;
          const batches = (await reader.xReadGroup(
            POST_GROUP,
            this.name,
            { key: POST_STREAM, id: '>' },
            { COUNT: 20, BLOCK: 1000 },
          )) as Array<{ messages: Entry[] }> | null;
          for (const batch of batches ?? [])
            for (const entry of batch.messages) await this.process(entry);
          if (Date.now() - this.lastMetrics > 30000) {
            this.lastMetrics = Date.now();
            const metrics = await this.metrics();
            log.success('consumer.metrics', 'Map consumer metrics.', {
              consumerGroup: POST_GROUP,
              pending: metrics.pending,
              oldestPendingIdleMs: metrics.oldestIdleMs,
              failed: metrics.failures,
              count: metrics.deadLetters,
            });
          }
        } catch (error) {
          if (this.stopped) break;
          this.failures++;
          log.failure(
            'consumer.poll.failed',
            error,
            'STREAM_POLL_FAILED',
            'Map consumer polling failed.',
            { consumerGroup: POST_GROUP },
            true,
          );
          await delay(500);
        }
      }
    } catch (error) {
      if (!this.stopped) throw error;
    } finally {
      if (reader.isOpen) reader.destroy();
      this.reader = undefined;
    }
  }

  async process(entry: Entry): Promise<void> {
    const fields = entry.message;
    const started = performance.now();
    const context = {
      stream: POST_STREAM,
      consumerGroup: POST_GROUP,
      streamId: entry.id,
      eventId: fields.eventId,
      eventType: fields.eventType,
    };
    if (
      fields.eventType &&
      !['PostCreated', 'PostExpired', 'PostDeleted', 'PostHidden'].includes(
        fields.eventType,
      )
    ) {
      await this.index.redis.xAck(POST_STREAM, POST_GROUP, entry.id);
      log.skipped('consumer.event.acknowledged', 'UNSUPPORTED_EVENT', context);
      return;
    }
    try {
      if (
        fields.eventType === 'PostHidden' ||
        fields.eventType === 'PostExpired' ||
        fields.eventType === 'PostDeleted'
      )
        await this.index.transition(parsePostStatus(fields.data, fields));
      else await this.index.write(parsePostCreated(fields.data, fields));
      await this.index.redis.xAck(POST_STREAM, POST_GROUP, entry.id);
      log.success(
        'consumer.event.acknowledged',
        'Map event processed and acknowledged.',
        { ...context, durationMs: performance.now() - started },
      );
    } catch (error) {
      this.failures++;
      const deliveries = await this.index.redis.xPendingRange(
        POST_STREAM,
        POST_GROUP,
        entry.id,
        entry.id,
        1,
      );
      const attempts = deliveries[0]?.deliveriesCounter ?? 1;
      const invalid =
        error instanceof Error && error.message.startsWith('Invalid');
      log.failure(
        'consumer.event.failed',
        error,
        invalid ? 'INVALID_CONTRACT' : 'EVENT_PROCESSING_FAILED',
        'Map event processing failed.',
        {
          ...context,
          attempt: attempts,
          durationMs: performance.now() - started,
        },
        !invalid && attempts < 5,
      );
      // DLQ 기록이 실패하면 ACK하지 않는다. 회수 후 다시 기록할 수 있어야 한다.
      if (invalid || attempts >= 5) {
        await this.index.redis.xAdd(DEAD_STREAM, '*', {
          streamId: entry.id,
          eventId: fields.eventId ?? '',
          error: String(error),
          data: fields.data ?? '',
        });
        log.failure(
          'consumer.event.dead_lettered',
          undefined,
          invalid ? 'INVALID_CONTRACT' : 'RETRY_EXHAUSTED',
          'Map event stored in dead letter stream.',
          { ...context, attempt: attempts },
          false,
        );
        await this.index.redis.xAck(POST_STREAM, POST_GROUP, entry.id);
        log.success(
          'consumer.dead_letter.acknowledged',
          'Dead letter event acknowledged.',
          context,
        );
      }
    }
  }
}
