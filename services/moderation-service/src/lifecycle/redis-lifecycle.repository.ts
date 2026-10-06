import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import type { LifecycleRepository } from './lifecycle.repository.js';
import type { LifecycleEvent, LifecycleProjection } from './lifecycle.js';

const INDEX = 'moderation:lifecycle:posts';

@Injectable()
export class RedisLifecycleRepository
  implements LifecycleRepository, OnModuleDestroy
{
  private readonly redis;
  private readonly eventStream: string;

  constructor(config: ConfigService) {
    this.redis = createClient({
      url: config.get<string>('redis.url') ?? 'redis://localhost:6383',
    });
    this.redis.on('error', () => undefined);
    this.eventStream =
      config.get<string>('redis.moderationEventStream') ?? 'moderation:events';
  }

  async create(projection: LifecycleProjection): Promise<boolean> {
    await this.connect();
    const result = await this.redis.eval(
      "if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end redis.call('SET', KEYS[1], ARGV[1]); redis.call('SADD', KEYS[2], ARGV[2]); return 1",
      {
        keys: [key(projection.postId), INDEX],
        arguments: [JSON.stringify(projection), projection.postId],
      },
    );
    return Number(result) === 1;
  }

  async find(postId: string): Promise<LifecycleProjection | null> {
    await this.connect();
    const value = await this.redis.get(key(postId));
    return value ? (JSON.parse(value) as LifecycleProjection) : null;
  }

  async list(): Promise<LifecycleProjection[]> {
    await this.connect();
    const postIds = await this.redis.sMembers(INDEX);
    if (postIds.length === 0) return [];
    const values = await this.redis.mGet(postIds.map(key));
    return values.flatMap((value) =>
      value ? [JSON.parse(value) as LifecycleProjection] : [],
    );
  }

  async transition(
    expectedVersion: number,
    next: LifecycleProjection,
    event?: LifecycleEvent,
  ): Promise<boolean> {
    await this.connect();
    const result = await this.redis.eval(
      "local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end; local current=cjson.decode(raw); if current.version~=tonumber(ARGV[1]) then return 0 end; redis.call('SET',KEYS[1],ARGV[2]); if ARGV[3]~='' then local e=cjson.decode(ARGV[3]); redis.call('XADD',KEYS[2],'*','eventId',e.eventId,'eventType',e.eventType,'data',ARGV[3]); end; return 1",
      {
        keys: [key(next.postId), this.eventStream],
        arguments: [
          String(expectedVersion),
          JSON.stringify(next),
          event ? JSON.stringify(event) : '',
        ],
      },
    );
    return Number(result) === 1;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }

  private async connect(): Promise<void> {
    if (!this.redis.isOpen) await this.redis.connect();
  }
}

function key(postId: string): string {
  return `moderation:lifecycle:${postId}`;
}
