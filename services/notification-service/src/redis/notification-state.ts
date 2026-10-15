import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { createClient } from 'redis';

export interface RedisCommands {
  isOpen: boolean;
  connect(): Promise<unknown>;
  quit(): Promise<unknown>;
  set(
    key: string,
    value: string,
    options?: { NX?: boolean; EX?: number },
  ): Promise<string | null>;
  get(key: string): Promise<string | null>;
  del(key: string): Promise<number>;
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
    const client = createClient({
      url,
      disableOfflineQueue: true,
      socket: { reconnectStrategy: false, connectTimeout: 1000 },
    });
    client.on('error', () => undefined);
    return new NotificationState(client as unknown as RedisCommands);
  }

  async claim(
    eventId: string,
    userId: string,
  ): Promise<'done' | 'acquired' | 'busy'> {
    const key = this.dedupKey(eventId, userId);
    if ((await this.run((redis) => redis.get(key))) === 'done') return 'done';
    return (await this.run((redis) =>
      redis.set(key, 'processing', { NX: true, EX: 30 }),
    )) === 'OK'
      ? 'acquired'
      : 'busy';
  }

  async complete(eventId: string, userId: string): Promise<void> {
    await this.run((redis) =>
      redis.set(this.dedupKey(eventId, userId), 'done', {
        EX: DEDUP_TTL_SECONDS,
      }),
    );
  }

  async release(eventId: string, userId: string): Promise<void> {
    await this.run((redis) => redis.del(this.dedupKey(eventId, userId)));
  }

  async unread(userId: string, load: () => Promise<number>): Promise<number> {
    // DB commit 후 cache 무효화 전에 죽어도 정확하도록 원본으로 검증한 snapshot만 반환한다.
    const count = await load();
    try {
      await this.run((redis) =>
        redis.set(`notification:unread:${userId}`, String(count), {
          EX: UNREAD_TTL_SECONDS,
        }),
      );
    } catch {}
    return count;
  }

  async incrementUnread(userId: string): Promise<void> {
    await this.invalidateUnread(userId);
  }

  async decrementUnread(userId: string): Promise<void> {
    await this.invalidateUnread(userId);
  }

  async invalidateUnread(userId: string): Promise<void> {
    try {
      await this.run((redis) => redis.del(`notification:unread:${userId}`));
    } catch {}
  }

  async reserveBundle(
    userId: string,
    targetId: string,
    type: string,
    notificationId: string,
  ): Promise<string> {
    const key = `notification:bundle:${userId}:${targetId}:${type}`;
    const reserved = await this.run((redis) =>
      redis.set(key, notificationId, { NX: true, EX: BUNDLE_TTL_SECONDS }),
    );
    if (reserved === 'OK') return notificationId;
    const existing = await this.run((redis) => redis.get(key));
    if (!existing) throw new Error('bundle reservation lost');
    return existing;
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
  }

  private async run<T>(
    action: (redis: RedisCommands) => Promise<T>,
  ): Promise<T> {
    if (!this.redis.isOpen) await this.redis.connect();
    return action(this.redis);
  }

  private dedupKey(eventId: string, userId: string): string {
    return `notification:dedup:${eventId}:${userId}`;
  }
}
