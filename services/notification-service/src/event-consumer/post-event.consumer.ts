import {
  Inject,
  Injectable,
  Optional,
  type OnModuleDestroy,
  type OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { createClient } from 'redis';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { parsePostEvent } from './post-event.js';
import { PostEventHandler } from './post-event.handler.js';
import {
  DurableStreamConsumer,
  type StreamEntry,
} from './durable-stream.consumer.js';
export const POST_REDIS_CLIENT = Symbol('POST_REDIS_CLIENT');

@Injectable()
export class PostEventConsumer implements OnModuleInit, OnModuleDestroy {
  readonly worker: DurableStreamConsumer | undefined;
  constructor(
    config: ConfigService,
    handler: PostEventHandler,
    @Optional()
    @Inject(POST_REDIS_CLIENT)
    redis?: ReturnType<typeof createClient>,
    @Optional() database?: PostgresDatabase,
  ) {
    const url = config.get<string>('redis.url');
    if (!url && !redis) return;
    if (!database)
      throw new Error('Post consumer requires durable PostgreSQL receipts');
    this.worker = new DurableStreamConsumer(
      database,
      {
        url: url ?? 'redis://localhost:6382',
        stream: 'post:events',
        group: 'post-notification',
        dead: 'notification:post:dead',
        pendingIdleMs: config.get<number>('redis.pendingIdleMs') ?? 30000,
        blockMs: config.get<number>('redis.blockMs') ?? 1000,
      },
      async (fields) => {
        if (!fields.data) throw new Error('Invalid post event: missing data');
        const event = parsePostEvent(fields.data, fields);
        if (event) await handler.handle(event);
        else await handler.ignore(fields);
      },
      redis,
    );
  }
  isReady() {
    return this.worker?.isReady() ?? false;
  }
  async onModuleInit() {
    await this.worker?.onModuleInit();
  }
  async onModuleDestroy() {
    await this.worker?.onModuleDestroy();
  }
  async process(entry: StreamEntry) {
    if (!this.worker) throw new Error('Post consumer disabled');
    await this.worker.process(entry);
  }
  async pollOnce() {
    if (!this.worker) throw new Error('Post consumer disabled');
    await this.worker.pollOnce();
  }
}
