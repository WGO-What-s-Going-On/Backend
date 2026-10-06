import {
  Inject,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

import { parsePostEvent } from './post-event.js';
import {
  POST_EVENT_PROCESSOR,
  type PostEventProcessor,
} from './post-event.processor.js';

export const POST_REDIS_CLIENT = Symbol('POST_REDIS_CLIENT');
type Entry = { id: string; message: Record<string, string> };

@Injectable()
export class PostEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEventConsumer.name);
  private readonly consumer = `moderation-${randomUUID()}`;
  private readonly stream: string;
  private readonly group: string;
  private readonly deadStream = 'moderation:post:dead';
  private readonly redis: ReturnType<typeof createClient>;
  private stopped: boolean;
  private running?: Promise<void>;

  constructor(
    config: ConfigService,
    @Inject(POST_EVENT_PROCESSOR)
    private readonly processor: PostEventProcessor,
    @Optional()
    @Inject(POST_REDIS_CLIENT)
    redis?: ReturnType<typeof createClient>,
  ) {
    const url = config.get<string>('redis.url');
    this.stream = config.get<string>('redis.postEventStream') ?? 'post:events';
    this.group =
      config.get<string>('redis.moderationConsumerGroup') ?? 'post-moderation';
    this.redis =
      redis ?? createClient({ url: url ?? 'redis://localhost:6383' });
    this.redis.on('error', (error) => this.logger.warn(error));
    this.stopped = !url && !redis;
  }

  async onModuleInit(): Promise<void> {
    if (this.stopped) return;
    if (!this.redis.isOpen) await this.redis.connect();
    try {
      await this.redis.xGroupCreate(this.stream, this.group, '0', {
        MKSTREAM: true,
      });
    } catch (error) {
      if (!String(error).includes('BUSYGROUP')) throw error;
    }
    this.running = this.loop();
  }

  async onModuleDestroy(): Promise<void> {
    this.stopped = true;
    if (this.redis.isOpen) await this.redis.disconnect();
    await this.running?.catch(() => undefined);
  }

  async process(entry: Entry): Promise<void> {
    try {
      const event = parsePostEvent(entry.message);
      if (event && (await this.claim(event.eventId))) {
        try {
          await this.processor.process(event);
          await this.complete(event.eventId);
        } catch (error) {
          await this.release(event.eventId);
          throw error;
        }
      }
      await this.redis.xAck(this.stream, this.group, entry.id);
    } catch (error) {
      const pending = await this.redis.xPendingRange(
        this.stream,
        this.group,
        entry.id,
        entry.id,
        1,
      );
      const attempts = pending[0]?.deliveriesCounter ?? 1;
      if (
        (error instanceof Error && error.message.startsWith('Invalid')) ||
        attempts >= 5
      ) {
        await this.redis.xAdd(this.deadStream, '*', {
          streamId: entry.id,
          eventId: entry.message.eventId ?? '',
          error: String(error),
          data: entry.message.data ?? '',
        });
        await this.redis.xAck(this.stream, this.group, entry.id);
      }
    }
  }

  private async claim(eventId: string): Promise<boolean> {
    const key = `moderation:dedup:${eventId}`;
    if ((await this.redis.get(key)) === 'done') return false;
    return (
      (await this.redis.set(key, 'processing', { NX: true, EX: 30 })) === 'OK'
    );
  }

  private async complete(eventId: string): Promise<void> {
    await this.redis.set(`moderation:dedup:${eventId}`, 'done', { EX: 604800 });
  }

  private async release(eventId: string): Promise<void> {
    await this.redis.del(`moderation:dedup:${eventId}`);
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        await this.pollOnce();
      } catch (error) {
        if (!this.stopped) {
          this.logger.warn(error);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }

  async pollOnce(): Promise<void> {
    const claimed = (await this.redis.xAutoClaim(
      this.stream,
      this.group,
      this.consumer,
      30_000,
      '0-0',
      { COUNT: 20 },
    )) as unknown as { messages: Entry[] };
    for (const entry of claimed.messages) if (entry) await this.process(entry);
    const batches = (await this.redis.xReadGroup(
      this.group,
      this.consumer,
      { key: this.stream, id: '>' },
      { COUNT: 20, BLOCK: 1000 },
    )) as unknown as Array<{ messages: Entry[] }> | null;
    for (const batch of batches ?? [])
      for (const entry of batch.messages) await this.process(entry);
  }
}
