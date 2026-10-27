import { Injectable, OnModuleDestroy, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import type { ModerationResultRepository } from './moderation-result.repository.js';
import type { StoredModerationResult } from './moderation-result.js';
import { contentEvent } from './content-event.js';

@Injectable()
export class RedisModerationResultRepository
  implements ModerationResultRepository, OnModuleDestroy
{
  private readonly redis;
  private readonly stream: string;
  private connecting: Promise<unknown> | undefined;
  private readonly logger = new Logger(RedisModerationResultRepository.name);

  constructor(config: ConfigService) {
    this.redis = createClient({
      url: config.get<string>('redis.url') ?? 'redis://localhost:6383',
      disableOfflineQueue: true,
      commandOptions: { timeout: 2000 },
      commandsQueueMaxLength: 1000,
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.redis.on('error', () => undefined);
    this.stream =
      config.get<string>('redis.contentEventStream') ??
      'moderation:content-events';
    if (
      this.stream ===
        (config.get<string>('redis.moderationEventStream') ??
          'moderation:events') ||
      this.stream ===
        (config.get<string>('redis.postEventStream') ?? 'post:events')
    )
      throw new Error('Content output requires a separate stream');
  }

  async find(eventId: string): Promise<StoredModerationResult | null> {
    await this.connect();
    const value = await this.redis.get(`moderation:content:${eventId}`);
    if (value) return JSON.parse(value) as StoredModerationResult;
    if (await this.redis.exists(`moderation:content-published:${eventId}`))
      throw new Error(
        'Moderation result retention expired; reviewed replay required',
      );
    return null;
  }

  async save(
    result: StoredModerationResult,
    republish = false,
  ): Promise<boolean> {
    await this.connect();
    // Redis Lua is isolated, but runtime errors do not roll writes back. Validate
    // key types before writes and retain the canonical result if XADD fails.
    const saved = await this.redis
      .eval(
        `
      local resultType=redis.call('TYPE',KEYS[1]).ok
      local streamType=redis.call('TYPE',KEYS[2]).ok
      local receiptType=redis.call('TYPE',KEYS[3]).ok
      if resultType~='none' and resultType~='string' then return redis.error_reply('WRONGTYPE content result') end
      if streamType~='none' and streamType~='stream' then return redis.error_reply('WRONGTYPE content output') end
      if receiptType~='none' and receiptType~='string' then return redis.error_reply('WRONGTYPE content receipt') end
      if redis.call('EXISTS',KEYS[3])==1 and ARGV[3]~='republish' then return 0 end
      local raw=redis.call('GET',KEYS[1]); local created=0
      if not raw then raw=ARGV[1]; created=1 end
      local canonical=cjson.decode(raw)
      local event=canonical.publication
      if not event then
        event=cjson.decode(ARGV[2])
        event.flagged=canonical.flagged; event.categories=canonical.categories; event.categoryScores=canonical.categoryScores
        event.model=canonical.model; event.evaluatedAt=canonical.moderatedAt; event.occurredAt=canonical.moderatedAt
        event.postId=canonical.postId; event.commentId=canonical.commentId; event.sourceEventId=canonical.eventId
        event.correlationId=canonical.correlationId or canonical.eventId
        event.authorId=canonical.authorId; event.activityVersion=canonical.activityVersion
        canonical.publication=event; raw=cjson.encode(canonical)
      end
      redis.call('SET',KEYS[1],raw,'EX',2592000)
      local added=redis.pcall('XADD',KEYS[2],'*','eventId',event.eventId,'eventType',event.eventType,'data',cjson.encode(event))
      if type(added)=='table' and added.err then return redis.error_reply('CONTENT_PUBLICATION_FAILED') end
      redis.call('SET',KEYS[3],event.eventId)
      return created
    `,
        {
          keys: [
            `moderation:content:${result.eventId}`,
            this.stream,
            `moderation:content-published:${result.eventId}`,
          ],
          arguments: [
            JSON.stringify({ ...result, publication: contentEvent(result) }),
            JSON.stringify(contentEvent(result)),
            republish ? 'republish' : 'ensure',
          ],
        },
      )
      .catch((error) => {
        this.logger.warn(
          JSON.stringify({
            event: 'content_result_publication_failed',
            service: 'moderation-service',
            sourceEventId: result.eventId,
          }),
        );
        throw error;
      });
    if (Number(saved) === 1)
      this.logger.log(
        JSON.stringify({
          event: 'content_result_published',
          service: 'moderation-service',
          sourceEventId: result.eventId,
          eventId: contentEvent(result).eventId,
        }),
      );
    return Number(saved) === 1;
  }

  async republish(eventId: string): Promise<void> {
    const result = await this.find(eventId);
    if (!result) throw new Error('Moderation result not found');
    await this.save(result, true);
  }

  async ready(): Promise<boolean> {
    await this.connect();
    const type = await this.redis.type(this.stream);
    return type === 'none' || type === 'stream';
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }

  private async connect(): Promise<void> {
    if (this.redis.isReady) return;
    this.connecting ??= this.redis.connect().finally(() => {
      this.connecting = undefined;
    });
    await this.connecting;
  }
}
