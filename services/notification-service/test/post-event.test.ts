import { ConfigService } from '@nestjs/config';
import { describe, expect, it, vi } from 'vitest';

import { PostEventConsumer } from '../src/event-consumer/post-event.consumer.js';
import { PostEventHandler } from '../src/event-consumer/post-event.handler.js';
import { parsePostEvent, type PostEvent } from '../src/event-consumer/post-event.js';
import type { RecipientResolver } from '../src/event-consumer/recipient-resolver.js';
import type { PushSender } from '../src/firebase/push.js';
import type { Notification } from '../src/notification/notification.js';
import type { NotificationRepository } from '../src/notification/notification.repository.js';
import { NotificationService } from '../src/notification/notification.service.js';
import { NotificationState, type RedisCommands } from '../src/redis/notification-state.js';

class MemoryNotifications implements NotificationRepository {
  items: Notification[] = [];
  async create(value: Notification) { if (this.items.some((item) => item.notificationId === value.notificationId)) return false; this.items.push(value); return true; }
  async list() { return { items: this.items }; }
  async markRead() { return null; }
  async increment(_userId: string, notificationId: string) { const item = this.items.find((value) => value.notificationId === notificationId); if (!item) return null; item.count++; return item; }
  async countUnread() { return this.items.filter((item) => !item.isRead).length; }
}

class MemoryRedis implements RedisCommands {
  isOpen = true;
  values = new Map<string, string>();
  async connect() {}
  async quit() {}
  async set(key: string, value: string, options?: { NX?: boolean }) { if (options?.NX && this.values.has(key)) return null; this.values.set(key, value); return 'OK'; }
  async get(key: string) { return this.values.get(key) ?? null; }
  async incr(key: string) { const value = Number(this.values.get(key) ?? 0) + 1; this.values.set(key, String(value)); return value; }
  async decr(key: string) { const value = Number(this.values.get(key) ?? 0) - 1; this.values.set(key, String(value)); return value; }
  async expire() { return true; }
}

const commentEvent = (eventId: string, actorId = '2'): PostEvent => ({
  eventId,
  eventType: 'PostCommentCreated',
  schemaVersion: 1,
  producer: 'post-service',
  aggregateId: 'post-1',
  occurredAt: '2026-01-01T00:00:00.000Z',
  actorId,
});

describe('post event parsing and handling', () => {
  it('parses the current Post Service envelope and rejects malformed envelopes', () => {
    expect(parsePostEvent(JSON.stringify({ ...commentEvent('event-1'), comment: { authorId: 2 } }))).toMatchObject({ eventType: 'PostCommentCreated', actorId: '2' });
    expect(() => parsePostEvent('{')).toThrow('Invalid post event JSON');
    expect(() => parsePostEvent(JSON.stringify({ ...commentEvent('event-1'), producer: 'other', comment: { authorId: 2 } }))).toThrow('Invalid post event envelope');
    expect(parsePostEvent(JSON.stringify({ eventType: 'FutureEvent' }))).toBeNull();
  });

  it('excludes self actions, deduplicates redelivery, and bundles follow-up events without another push', async () => {
    const repository = new MemoryNotifications();
    const state = new NotificationState(new MemoryRedis());
    const push: PushSender = { send: vi.fn().mockResolvedValue({ attempted: 1, succeeded: 1, failed: 0, invalidTokens: [] }) };
    const recipients: RecipientResolver = { postAuthor: vi.fn().mockResolvedValue('1') };
    const handler = new PostEventHandler(new NotificationService(repository, state), repository, state, push, recipients);

    await handler.handle(commentEvent('self', '1'));
    await handler.handle(commentEvent('event-1'));
    await handler.handle(commentEvent('event-1'));
    await handler.handle(commentEvent('event-2', '3'));
    expect(repository.items).toHaveLength(1);
    expect(repository.items[0]?.count).toBe(2);
    expect(push.send).toHaveBeenCalledOnce();
  });
});

describe('PostEventConsumer ACK policy', () => {
  it('ACKs unsupported events and dead-letters malformed events', async () => {
    const handler = { handle: vi.fn() } as unknown as PostEventHandler;
    const consumer = new PostEventConsumer(new ConfigService(), handler);
    const redis = {
      xAck: vi.fn().mockResolvedValue(1),
      xAdd: vi.fn().mockResolvedValue('1-0'),
      xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 1 }]),
    };
    (consumer as unknown as { redis: typeof redis }).redis = redis;
    await consumer.process({ id: '1-0', message: { data: JSON.stringify({ eventType: 'FutureEvent' }) } });
    await consumer.process({ id: '2-0', message: { data: '{' } });
    expect(redis.xAck).toHaveBeenCalledTimes(2);
    expect(redis.xAdd).toHaveBeenCalledOnce();
  });

  it('leaves transient handler failures pending before the retry limit', async () => {
    const handler = { handle: vi.fn().mockRejectedValue(new Error('temporary')) } as unknown as PostEventHandler;
    const consumer = new PostEventConsumer(new ConfigService(), handler);
    const redis = {
      xAck: vi.fn(),
      xAdd: vi.fn(),
      xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 2 }]),
    };
    (consumer as unknown as { redis: typeof redis }).redis = redis;
    await consumer.process({ id: '1-0', message: { data: JSON.stringify({ ...commentEvent('event-1'), comment: { authorId: 2 } }) } });
    expect(redis.xAck).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
  });
});
