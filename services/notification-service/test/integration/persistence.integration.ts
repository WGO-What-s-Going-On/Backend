import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { harness } from './harness.js';
import { GetCommand, PutCommand } from '@aws-sdk/lib-dynamodb';
describe('real DynamoDB Local persistence', () => {
  let h: Awaited<ReturnType<typeof harness>>;
  beforeEach(async () => {
    h = await harness();
  });
  afterEach(async () => {
    if (h?.redis.isOpen) await h.cleanup();
  });
  it('conditionally creates, paginates newest first, isolates users and stores 30 day TTL', async () => {
    const now = new Date();
    const input = {
      userId: '1',
      type: 'POST_COMMENTED',
      title: '댓글',
      body: '새 댓글',
    };
    h.ownedKeys.add('notification:unread:1');
    h.ownedKeys.add('notification:unread:2');
    const first = await h.notifications.create(input, now, '2026-01-01_a');
    await h.notifications.create(input, now, '2026-01-02_b');
    await h.notifications.create(
      { ...input, userId: '2' },
      now,
      '2026-01-03_c',
    );
    expect(first).toMatchObject({
      count: 1,
      isRead: false,
      expiresAt: Math.floor(now.getTime() / 1000) + 2_592_000,
    });
    expect(await h.repository.create(first!)).toBe(false);
    const page = await h.notifications.list('1', 1);
    expect(page.items.map((n) => n.notificationId)).toEqual(['2026-01-02_b']);
    expect(page.nextCursor).toBeDefined();
    expect(
      (await h.notifications.list('1', 1, page.nextCursor)).items.map(
        (n) => n.notificationId,
      ),
    ).toEqual(['2026-01-01_a']);
    expect((await h.notifications.list('2')).items).toHaveLength(1);
    expect(() => h.notifications.list('1', 0)).toThrow();
  });
  it('keeps owner-only read idempotent and repairs lost/stale unread cache', async () => {
    h.ownedKeys.add('notification:unread:1');
    const input = { userId: '1', type: 'A', title: 'a', body: 'a' };
    const first = await h.notifications.create(input);
    await h.notifications.create(input);
    expect(await h.notifications.unread('1')).toBe(2);
    expect(
      await h.notifications.markRead('2', first!.notificationId),
    ).toBeNull();
    await h.notifications.markRead('1', first!.notificationId);
    expect(
      await h.notifications.markRead('1', first!.notificationId),
    ).toMatchObject({ isRead: true });
    await h.redis.set('notification:unread:1', '999');
    expect(await h.notifications.unread('1')).toBe(1);
    await h.redis.del('notification:unread:1');
    expect(await h.notifications.unread('1')).toBe(1);
    expect(await h.redis.get('notification:unread:1')).toBe('1');
  });
  it('upserts multiple devices, protects token ownership and cleans invalid tokens', async () => {
    const first = await h.subscriptions.upsert(
      '1',
      'token-a',
      'web',
      new Date('2026-01-01'),
    );
    const updated = await h.subscriptions.upsert(
      '1',
      'token-a',
      'android',
      new Date('2026-01-02'),
    );
    expect(updated.createdAt).toBe(first.createdAt);
    expect(updated.updatedAt).toBe('2026-01-02T00:00:00.000Z');
    await h.subscriptions.upsert('1', 'token-b', 'ios');
    await expect(
      h.subscriptions.upsert('2', 'token-a', 'web'),
    ).rejects.toThrow();
    await h.subscriptions.remove('2', 'token-a');
    expect(await h.subscriptions.list('1')).toHaveLength(2);
    expect(await h.subscriptions.list('2')).toHaveLength(0);
    await h.subscriptions.removeInvalid('1', ['token-a', 'token-a']);
    expect((await h.subscriptions.list('1')).map((s) => s.token)).toEqual([
      'token-b',
    ]);
    await h.subscriptions.upsert('2', 'token-a', 'web');
    await h.subscriptions.remove('1', 'token-b');
    expect(await h.subscriptions.list('1')).toHaveLength(0);
  });
  it('filters expired rows without assuming Local TTL deletion and fills pages across hidden items', async () => {
    h.ownedKeys.add('notification:unread:1');
    const input = { userId: '1', type: 'A', title: 'a', body: 'a' };
    await h.notifications.create(input, new Date(), '2026-01-01_a');
    const expired = await h.notifications.create(
      input,
      new Date('2025-01-01'),
      '2026-01-02_b',
    );
    await h.notifications.create(input, new Date(), '2026-01-03_c');
    expect(
      (await h.notifications.list('1', 2)).items.map((n) => n.notificationId),
    ).toEqual(['2026-01-03_c', '2026-01-01_a']);
    expect(await h.notifications.unread('1')).toBe(2);
    expect(
      (
        await h.client.send(
          new GetCommand({
            TableName: h.tables.notificationsTable,
            Key: { userId: '1', notificationId: expired!.notificationId },
            ConsistentRead: true,
          }),
        )
      ).Item,
    ).toBeDefined();
    await expect(h.notifications.list('1', 1, '!!!')).rejects.toThrow(
      'invalid cursor',
    );
  });
  it('protects token ownership for rows created before the ownership record existed', async () => {
    await h.client.send(
      new PutCommand({
        TableName: h.tables.pushSubscriptionsTable,
        Item: {
          userId: '1',
          token: 'legacy-token',
          platform: 'web',
          createdAt: '2026-01-01',
          updatedAt: '2026-01-01',
          lastSeenAt: '2026-01-01',
        },
      }),
    );
    await expect(
      h.subscriptions.upsert('2', 'legacy-token', 'web'),
    ).rejects.toThrow('Token already belongs');
    expect(await h.subscriptions.list('1')).toHaveLength(1);
    await h.subscriptions.upsert('1', 'legacy-token', 'web');
    expect(await h.subscriptions.list('1')).toHaveLength(1);
  });
});
