import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient } from 'redis';

export interface RedisCommands {
  isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  set(key: string, value: string, options?: { NX?: boolean; EX?: number }): Promise<string | null>;
  get(key: string): Promise<string | null>;
  incr(key: string): Promise<number>;
  decr(key: string): Promise<number>;
  expire(key: string, seconds: number): Promise<boolean>;
}

const DEDUP_TTL_SECONDS = 7 * 24 * 60 * 60;
const UNREAD_TTL_SECONDS = 24 * 60 * 60;
const BUNDLE_TTL_SECONDS = 2 * 60;

@Injectable()
export class NotificationState implements OnModuleDestroy {
  constructor(private readonly redis: RedisCommands) {}

  static fromUrl(url: string): NotificationState {
    const client = createClient({ url });
    client.on('error', () => undefined);
    return new NotificationState(client as unknown as RedisCommands);
  }

  async claim(eventId: string, userId: string): Promise<boolean> {
    return (await this.run((redis) => redis.set(`notification:dedup:${eventId}:${userId}`, '1', { NX: true, EX: DEDUP_TTL_SECONDS }))) === 'OK';
  }

  async unread(userId: string, load: () => Promise<number>): Promise<number> {
    try {
      const cached = await this.run((redis) => redis.get(`notification:unread:${userId}`));
      if (cached !== null && Number.isInteger(Number(cached))) return Number(cached);
    } catch {
      // DynamoDB remains the source of truth when the cache is unavailable.
    }
    const count = await load();
    try {
      await this.run((redis) => redis.set(`notification:unread:${userId}`, String(count), { EX: UNREAD_TTL_SECONDS }));
    } catch {}
    return count;
  }

  async incrementUnread(userId: string): Promise<void> {
    try {
      await this.run(async (redis) => {
        await redis.incr(`notification:unread:${userId}`);
        await redis.expire(`notification:unread:${userId}`, UNREAD_TTL_SECONDS);
      });
    } catch {}
  }

  async decrementUnread(userId: string): Promise<void> {
    try {
      await this.run(async (redis) => {
        const value = await redis.decr(`notification:unread:${userId}`);
        if (value < 0) await redis.set(`notification:unread:${userId}`, '0', { EX: UNREAD_TTL_SECONDS });
      });
    } catch {}
  }

  async reserveBundle(userId: string, targetId: string, type: string, notificationId: string): Promise<string> {
    const key = `notification:bundle:${userId}:${targetId}:${type}`;
    const reserved = await this.run((redis) => redis.set(key, notificationId, { NX: true, EX: BUNDLE_TTL_SECONDS }));
    if (reserved === 'OK') return notificationId;
    const existing = await this.run((redis) => redis.get(key));
    if (!existing) throw new Error('bundle reservation lost');
    return existing;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }

  private async run<T>(action: (redis: RedisCommands) => Promise<T>): Promise<T> {
    if (!this.redis.isOpen) await this.redis.connect();
    return action(this.redis);
  }
}
