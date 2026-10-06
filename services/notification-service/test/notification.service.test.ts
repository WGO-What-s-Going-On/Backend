import { describe, expect, it } from 'vitest';

import type { Notification, NotificationPage } from '../src/notification/notification.js';
import type { NotificationRepository } from '../src/notification/notification.repository.js';
import { NotificationService } from '../src/notification/notification.service.js';

class MemoryRepository implements NotificationRepository {
  items: Notification[] = [];
  async create(value: Notification) { this.items.push(value); }
  async list(userId: string, limit: number, cursor?: string): Promise<NotificationPage> {
    const rows = this.items.filter((item) => item.userId === userId).sort((a, b) => b.notificationId.localeCompare(a.notificationId));
    const start = cursor ? rows.findIndex((item) => item.notificationId === cursor) + 1 : 0;
    return { items: rows.slice(start, start + limit) };
  }
  async markRead(userId: string, notificationId: string) {
    const item = this.items.find((value) => value.userId === userId && value.notificationId === notificationId);
    if (!item) return null;
    item.isRead = true;
    return item;
  }
  async increment(userId: string, notificationId: string) {
    const item = this.items.find((value) => value.userId === userId && value.notificationId === notificationId);
    if (!item) return null;
    item.count++;
    return item;
  }
  async countUnread(userId: string) { return this.items.filter((item) => item.userId === userId && !item.isRead).length; }
}

describe('NotificationService', () => {
  it('creates a notification with a 30 day TTL and excludes self actions', async () => {
    const repository = new MemoryRepository();
    const service = new NotificationService(repository);
    const now = new Date('2026-01-01T00:00:00.000Z');
    const created = await service.create({ userId: '1', actorId: '2', type: 'POST_LIKED', title: '좋아요', body: '게시물에 좋아요를 눌렀습니다.' }, now);
    expect(created?.expiresAt).toBe(Math.floor(now.getTime() / 1000) + 2_592_000);
    await expect(service.create({ userId: '1', actorId: '1', type: 'POST_LIKED', title: '', body: '' }, now)).resolves.toBeNull();
    expect(repository.items).toHaveLength(1);
  });

  it('lists only the owner notifications newest first and paginates', async () => {
    const repository = new MemoryRepository();
    const service = new NotificationService(repository);
    await service.create({ userId: '1', type: 'A', title: 'a', body: 'a' }, new Date('2026-01-01'));
    await service.create({ userId: '2', type: 'B', title: 'b', body: 'b' }, new Date('2026-01-02'));
    await service.create({ userId: '1', type: 'C', title: 'c', body: 'c' }, new Date('2026-01-03'));
    const page = await service.list('1', 1);
    expect(page.items.map((item) => item.type)).toEqual(['C']);
  });

  it('marks only a notification owned by the user as read', async () => {
    const repository = new MemoryRepository();
    const service = new NotificationService(repository);
    const item = await service.create({ userId: '1', type: 'A', title: 'a', body: 'a' });
    await expect(service.markRead('2', item!.notificationId)).resolves.toBeNull();
    await expect(service.markRead('1', item!.notificationId)).resolves.toMatchObject({ isRead: true });
  });
});
