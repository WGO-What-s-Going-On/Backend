import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';

import { parsePostEvent } from './post-event.js';
import { PostEventHandler } from './post-event.handler.js';

const STREAM = 'post:events';
const GROUP = 'post-notification';
const DEAD_STREAM = 'notification:post:dead';
type Entry = { id: string; message: Record<string, string> };

@Injectable()
export class PostEventConsumer implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PostEventConsumer.name);
  private readonly consumer = `notification-${randomUUID()}`;
  private readonly redis;
  private stopped = false;
  private running?: Promise<void>;

  constructor(config: ConfigService, private readonly handler: PostEventHandler) {
    const url = config.get<string>('redis.url');
    this.redis = createClient({ url: url ?? 'redis://localhost:6382' });
    this.redis.on('error', (error) => this.logger.warn(error));
    if (!url) this.stopped = true;
  }

  async onModuleInit(): Promise<void> {
    if (this.stopped) return;
    await this.redis.connect();
    try {
      await this.redis.xGroupCreate(STREAM, GROUP, '0', { MKSTREAM: true });
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
    const raw = entry.message.data;
    try {
      if (!raw) throw new Error('Invalid post event: missing data');
      const event = parsePostEvent(raw);
      if (event) await this.handler.handle(event);
      await this.redis.xAck(STREAM, GROUP, entry.id);
    } catch (error) {
      const invalid = error instanceof Error && error.message.startsWith('Invalid');
      const pending = await this.redis.xPendingRange(STREAM, GROUP, entry.id, entry.id, 1);
      const attempts = pending[0]?.deliveriesCounter ?? 1;
      if (invalid || attempts >= 5) {
        await this.redis.xAdd(DEAD_STREAM, '*', {
          streamId: entry.id,
          eventId: entry.message.eventId ?? '',
          error: String(error),
          data: raw ?? '',
        });
        await this.redis.xAck(STREAM, GROUP, entry.id);
      }
    }
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      try {
        const claimed = (await this.redis.xAutoClaim(
          STREAM,
          GROUP,
          this.consumer,
          30_000,
          '0-0',
          { COUNT: 20 },
        )) as unknown as { messages: Entry[] };
        for (const entry of claimed.messages) if (entry) await this.process(entry);
        const batches = (await this.redis.xReadGroup(
          GROUP,
          this.consumer,
          { key: STREAM, id: '>' },
          { COUNT: 20, BLOCK: 1000 },
        )) as unknown as Array<{ messages: Entry[] }> | null;
        for (const batch of batches ?? []) for (const entry of batch.messages) await this.process(entry);
      } catch (error) {
        if (!this.stopped) {
          this.logger.warn(error);
          await new Promise((resolve) => setTimeout(resolve, 500));
        }
      }
    }
  }
}
