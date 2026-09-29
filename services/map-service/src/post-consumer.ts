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

  stop(): void {
    this.stopped = true;
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

  async run(): Promise<void> {
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
        const batches = (await this.index.redis.xReadGroup(
          POST_GROUP,
          this.name,
          { key: POST_STREAM, id: '>' },
          { COUNT: 20, BLOCK: 1000 },
        )) as Array<{ messages: Entry[] }> | null;
        for (const batch of batches ?? [])
          for (const entry of batch.messages) await this.process(entry);
        if (Date.now() - this.lastMetrics > 30000) {
          this.lastMetrics = Date.now();
          console.info('post-map metrics', await this.metrics());
        }
      } catch (error) {
        this.failures++;
        console.error('post-map loop failed', error);
        await delay(500);
      }
    }
  }

  async process(entry: Entry): Promise<void> {
    const fields = entry.message;
    if (
      fields.eventType &&
      !['PostCreated', 'PostExpired', 'PostDeleted'].includes(fields.eventType)
    ) {
      await this.index.redis.xAck(POST_STREAM, POST_GROUP, entry.id);
      return;
    }
    try {
      if (
        fields.eventType === 'PostExpired' ||
        fields.eventType === 'PostDeleted'
      )
        await this.index.transition(parsePostStatus(fields.data, fields));
      else await this.index.write(parsePostCreated(fields.data, fields));
      await this.index.redis.xAck(POST_STREAM, POST_GROUP, entry.id);
    } catch (error) {
      this.failures++;
      console.error('post-map processing failed', {
        streamId: entry.id,
        eventId: fields.eventId,
        error,
      });
      const deliveries = await this.index.redis.xPendingRange(
        POST_STREAM,
        POST_GROUP,
        entry.id,
        entry.id,
        1,
      );
      const attempts = deliveries[0]?.deliveriesCounter ?? 1;
      // DLQ 기록이 실패하면 ACK하지 않는다. 회수 후 다시 기록할 수 있어야 한다.
      if (
        (error instanceof Error && error.message.startsWith('Invalid')) ||
        attempts >= 5
      ) {
        await this.index.redis.xAdd(DEAD_STREAM, '*', {
          streamId: entry.id,
          eventId: fields.eventId ?? '',
          error: String(error),
          data: fields.data ?? '',
        });
        await this.index.redis.xAck(POST_STREAM, POST_GROUP, entry.id);
      }
    }
  }
}
