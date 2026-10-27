import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';

import type { LifecycleRepository } from './lifecycle.repository.js';
import type { LifecycleEvent, LifecycleProjection } from './lifecycle.js';

const INDEX = 'moderation:lifecycle:posts';
export const DUE_INDEX = 'moderation:lifecycle:due';
function dueAt(p: LifecycleProjection): number {
  return p.state === 'STALE' && p.staleAt
    ? Date.parse(p.staleAt) + 600_000
    : Math.max(
        Date.parse(p.createdAt) + 3_600_000,
        Date.parse(p.lastMeaningfulActivityAt) + 1_800_000,
      );
}

@Injectable()
export class RedisLifecycleRepository
  implements LifecycleRepository, OnModuleDestroy
{
  private readonly redis;
  private readonly eventStream: string;
  private connecting: Promise<unknown> | undefined;

  constructor(config: ConfigService) {
    this.redis = createClient({
      url: config.get<string>('redis.url') ?? 'redis://localhost:6383',
      disableOfflineQueue: true,
      commandOptions: { timeout: 2000 },
      commandsQueueMaxLength: 1000,
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.redis.on('error', () => undefined);
    this.eventStream =
      config.get<string>('redis.moderationEventStream') ?? 'moderation:events';
  }

  async create(projection: LifecycleProjection): Promise<boolean> {
    await this.connect();
    const result = await this.redis.eval(
      `if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
       local p=cjson.decode(ARGV[1]); local t=redis.call('TYPE',KEYS[2]).ok
       if t~='none' and t~='set' then return redis.error_reply('WRONGTYPE lifecycle index') end
       local dt=redis.call('TYPE',KEYS[3]).ok
       if dt~='none' and dt~='zset' then return redis.error_reply('WRONGTYPE lifecycle due index') end
       redis.call('SET',KEYS[1],ARGV[1])
       if p.state~='CLOSED' then redis.call('SADD',KEYS[2],ARGV[2]); redis.call('ZADD',KEYS[3],ARGV[3],ARGV[2]) end
       return 1`,
      {
        keys: [key(projection.postId), INDEX, DUE_INDEX],
        arguments: [
          JSON.stringify(projection),
          projection.postId,
          String(dueAt(projection)),
        ],
      },
    );
    return Number(result) === 1;
  }

  async find(postId: string): Promise<LifecycleProjection | null> {
    await this.connect();
    for (let attempt = 0; attempt < 8; attempt++) {
      const value = await this.redis.get(key(postId));
      if (!value) return null;
      const projection = JSON.parse(value) as LifecycleProjection;
      const event = projection.pendingPublication;
      if (!event) return projection;
      const { pendingPublication: _, ...clean } = projection;
      // A failed XADD leaves its exact event inside the committed projection.
      // Recover it before any later decision, including a terminal no-op.
      const recovered = await this.redis.eval(
        `
        if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
        local st=redis.call('TYPE',KEYS[2]).ok
        local it=redis.call('TYPE',KEYS[3]).ok
        local dt=redis.call('TYPE',KEYS[4]).ok
        if (st~='none' and st~='stream') or (it~='none' and it~='set') or (dt~='none' and dt~='zset') then return redis.error_reply('WRONGTYPE lifecycle publication') end
        local e=cjson.decode(ARGV[3]);local p=cjson.decode(ARGV[2])
        local added=redis.pcall('XADD',KEYS[2],'*','eventId',e.eventId,'eventType',e.eventType,'data',ARGV[3])
        if type(added)=='table' and added.err then return redis.error_reply('LIFECYCLE_PUBLICATION_FAILED') end
        redis.call('SET',KEYS[1],ARGV[2])
        if p.state=='CLOSED' then redis.call('SREM',KEYS[3],p.postId);redis.call('ZREM',KEYS[4],p.postId)
        else redis.call('ZADD',KEYS[4],ARGV[4],p.postId) end
        return 1
      `,
        {
          keys: [key(postId), this.eventStream, INDEX, DUE_INDEX],
          arguments: [
            value,
            JSON.stringify(clean),
            JSON.stringify(event),
            String(dueAt(clean)),
          ],
        },
      );
      if (Number(recovered) === 1) return clean;
    }
    throw new Error('Lifecycle publication recovery contention');
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

  async due(now: Date, limit: number): Promise<string[]> {
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100)
      throw new Error('Invalid lifecycle batch size');
    await this.connect();
    if (!(await this.ready()))
      throw new Error('Lifecycle due index requires migration');
    // Claim only due IDs. Scores become short recovery leases; projection CAS
    // remains authoritative if a slow worker outlives its lease.
    return (await this.redis.eval(
      `
      local ids=redis.call('ZRANGEBYSCORE',KEYS[1],'-inf',ARGV[1],'LIMIT',0,ARGV[2])
      for _,id in ipairs(ids) do redis.call('ZADD',KEYS[1],ARGV[3],id) end
      return ids
    `,
      {
        keys: [DUE_INDEX],
        arguments: [
          String(now.getTime()),
          String(limit),
          String(now.getTime() + 60_000),
        ],
      },
    )) as string[];
  }

  async ready(): Promise<boolean> {
    await this.connect();
    return (
      Number(
        await this.redis.eval(
          "if redis.call('SCARD',KEYS[1])==redis.call('ZCARD',KEYS[2]) then return 1 else return 0 end",
          { keys: [INDEX, DUE_INDEX], arguments: [] },
        ),
      ) === 1
    );
  }

  async transition(
    expectedVersion: number,
    next: LifecycleProjection,
    event?: LifecycleEvent,
  ): Promise<boolean> {
    await this.connect();
    const result = await this.redis.eval(
      `local raw=redis.call('GET',KEYS[1]); if not raw then return 0 end
       local current=cjson.decode(raw); if current.version~=tonumber(ARGV[1]) then return 0 end
       local p=cjson.decode(ARGV[2]); local e=nil
       if ARGV[3]~='' then
         e=cjson.decode(ARGV[3]); local t=redis.call('TYPE',KEYS[2]).ok
         if t~='none' and t~='stream' then return redis.error_reply('WRONGTYPE moderation event stream') end
       end
       local t=redis.call('TYPE',KEYS[3]).ok
       if t~='none' and t~='set' then return redis.error_reply('WRONGTYPE lifecycle index') end
       local dt=redis.call('TYPE',KEYS[4]).ok
       if dt~='none' and dt~='zset' then return redis.error_reply('WRONGTYPE lifecycle due index') end
       redis.call('SET',KEYS[1],ARGV[2])
       if e then
         redis.call('SADD',KEYS[3],p.postId);redis.call('ZADD',KEYS[4],ARGV[5],p.postId)
         local added=redis.pcall('XADD',KEYS[2],'*','eventId',e.eventId,'eventType',e.eventType,'data',ARGV[3])
         if type(added)=='table' and added.err then return redis.error_reply('LIFECYCLE_PUBLICATION_FAILED') end
         redis.call('SET',KEYS[1],ARGV[6])
       end
       if p.state=='CLOSED' then redis.call('SREM',KEYS[3],p.postId); redis.call('ZREM',KEYS[4],p.postId)
       else redis.call('ZADD',KEYS[4],ARGV[4],p.postId) end
       return 1`,
      {
        keys: [key(next.postId), this.eventStream, INDEX, DUE_INDEX],
        arguments: [
          String(expectedVersion),
          JSON.stringify(event ? { ...next, pendingPublication: event } : next),
          event ? JSON.stringify(event) : '',
          String(dueAt(next)),
          String(event ? Date.parse(event.occurredAt) + 60_000 : dueAt(next)),
          JSON.stringify(next),
        ],
      },
    );
    return Number(result) === 1;
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

function key(postId: string): string {
  return `moderation:lifecycle:${postId}`;
}
