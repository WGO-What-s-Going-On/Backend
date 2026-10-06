import { describe, expect, it } from 'vitest';

import {
  NotificationState,
  type RedisCommands,
} from '../src/redis/notification-state.js';

class MemoryRedis implements RedisCommands {
  isOpen = false;
  values = new Map<string, string>();
  async connect() {
    this.isOpen = true;
  }
  async quit() {
    this.isOpen = false;
  }
  async set(key: string, value: string, options?: { NX?: boolean }) {
    if (options?.NX && this.values.has(key)) return null;
    this.values.set(key, value);
    return 'OK';
  }
  async get(key: string) {
    return this.values.get(key) ?? null;
  }
  async del(key: string) {
    return this.values.delete(key) ? 1 : 0;
  }
  async incr(key: string) {
    const value = Number(this.values.get(key) ?? 0) + 1;
    this.values.set(key, String(value));
    return value;
  }
  async decr(key: string) {
    const value = Number(this.values.get(key) ?? 0) - 1;
    this.values.set(key, String(value));
    return value;
  }
  async expire() {
    return true;
  }
}

describe('NotificationState', () => {
  it('claims an event once per recipient', async () => {
    const state = new NotificationState(new MemoryRedis());
    await expect(state.claim('event-1', 'user-1')).resolves.toBe(true);
    await expect(state.claim('event-1', 'user-1')).resolves.toBe(false);
    await expect(state.claim('event-1', 'user-2')).resolves.toBe(true);
  });

  it('loads and caches unread count, then updates the cache', async () => {
    const state = new NotificationState(new MemoryRedis());
    let loads = 0;
    const load = async () => ++loads;
    await expect(state.unread('user-1', load)).resolves.toBe(1);
    await state.incrementUnread('user-1');
    await expect(state.unread('user-1', load)).resolves.toBe(2);
    expect(loads).toBe(1);
  });

  it('reserves one notification for concurrent events in a bundle window', async () => {
    const state = new NotificationState(new MemoryRedis());
    await expect(
      state.reserveBundle('user-1', 'post-1', 'COMMENT', 'notification-1'),
    ).resolves.toBe('notification-1');
    await expect(
      state.reserveBundle('user-1', 'post-1', 'COMMENT', 'notification-2'),
    ).resolves.toBe('notification-1');
  });
});
