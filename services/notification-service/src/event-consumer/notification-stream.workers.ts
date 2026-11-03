import {
  Injectable,
  type OnModuleInit,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { DurableStreamConsumer } from './durable-stream.consumer.js';
import { UserEventHandler } from './user-event.handler.js';
import { ModerationEventHandler } from './moderation-event.handler.js';

@Injectable()
export class NotificationStreamWorkers
  implements OnModuleInit, OnModuleDestroy
{
  readonly consumers: DurableStreamConsumer[] = [];
  constructor(
    private readonly config: ConfigService,
    private readonly database: PostgresDatabase,
    private readonly users: UserEventHandler,
    private readonly moderation: ModerationEventHandler,
  ) {}
  isReady() {
    return this.consumers.every((c) => c.isReady());
  }
  async onModuleInit() {
    const url = this.config.get<string>('redis.url');
    if (!url) return;
    if (process.env.NOTIFICATION_USER_EVENTS_ENABLED !== 'false')
      this.consumers.push(
        new DurableStreamConsumer(
          this.database,
          {
            url,
            stream: 'user:events',
            group: 'user-notification',
            dead: 'notification:user:dead',
          },
          (fields) => this.users.handle(fields),
        ),
      );
    if (process.env.NOTIFICATION_MODERATION_EVENTS_ENABLED !== 'false')
      for (const [stream, group, dead] of [
        [
          'moderation:events',
          'moderation-notification',
          'notification:moderation:dead',
        ],
        [
          'moderation:report-events',
          'moderation-report-notification',
          'notification:report:dead',
        ],
        [
          'moderation:content-events',
          'moderation-content-notification',
          'notification:content:dead',
        ],
      ] as const)
        this.consumers.push(
          new DurableStreamConsumer(
            this.database,
            { url, stream, group, dead },
            (fields) => this.moderation.handle(stream, fields),
          ),
        );
    for (const consumer of this.consumers) await consumer.onModuleInit();
  }
  async onModuleDestroy() {
    await Promise.all(this.consumers.map((c) => c.onModuleDestroy()));
  }
}
