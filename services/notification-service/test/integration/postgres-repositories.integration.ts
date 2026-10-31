import { afterEach, beforeEach, expect, it } from 'vitest';
import { postgresHarness } from './postgres-harness.js';
import { PostgresNotificationRepository } from '../../src/persistence/postgres-notification.repository.js';
import { PostgresPushSubscriptionRepository } from '../../src/persistence/postgres-push-subscription.repository.js';
import { migrate } from '../../src/persistence/schema.js';
import type { Notification } from '../../src/notification/notification.js';

let h: Awaited<ReturnType<typeof postgresHarness>>;
beforeEach(async () => {
  h = await postgresHarness();
});
afterEach(async () => {
  if (h) await h.cleanup();
});
const row = (id: string): Notification => ({
  userId: 'owner',
  notificationId: id,
  type: 'POST_COMMENTED',
  title: 'comment',
  body: 'comment',
  count: 1,
  isRead: false,
  expiresAt: Math.floor(Date.now() / 1000) + 3600,
  createdAt: new Date().toISOString(),
  actorId: 'actor',
  targetId: 'post',
  targetType: 'post',
  actionPath: '/posts/post',
});
it('initializes idempotently and atomically preserves inbox ownership, pagination and expiry', async () => {
  await migrate(h.database.pool);
  const repo = new PostgresNotificationRepository(h.database);
  expect(
    await Promise.all([repo.create(row('a')), repo.create(row('a'))]),
  ).toEqual([true, false]);
  await repo.create(row('b'));
  await repo.create({ ...row('c'), expiresAt: 0 });
  const first = await repo.list('owner', 1);
  expect(first.items.map((x) => x.notificationId)).toEqual(['b']);
  expect(
    (await repo.list('owner', 1, first.nextCursor)).items.map(
      (x) => x.notificationId,
    ),
  ).toEqual(['a']);
  expect(await repo.markRead('other', 'a')).toBeNull();
  await repo.remove('other', 'a');
  expect(await repo.countUnread('owner')).toBe(2);
  await repo.markRead('owner', 'a');
  await repo.markRead('owner', 'a');
  expect(await repo.countUnread('owner')).toBe(1);
  await repo.remove('owner', 'b');
  expect(await repo.increment('owner', 'b')).toBeNull();
  expect(await repo.countUnread('owner')).toBe(0);
});
it('uses a database constraint to prevent simultaneous token ownership and preserves first creation time', async () => {
  const repo = new PostgresPushSubscriptionRepository(h.database);
  const sub = {
    userId: 'a',
    token: 'shared',
    platform: 'web' as const,
    createdAt: 'first',
    updatedAt: 'first',
    lastSeenAt: 'first',
  };
  const attempts = await Promise.allSettled([
    repo.upsert(sub),
    repo.upsert({ ...sub, userId: 'b' }),
  ]);
  expect(attempts.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  const winner = attempts[0]?.status === 'fulfilled' ? 'a' : 'b';
  const loser = winner === 'a' ? 'b' : 'a';
  await repo.remove(loser, 'shared');
  expect(await repo.list(winner)).toHaveLength(1);
  expect(
    await repo.upsert({
      ...sub,
      userId: winner,
      createdAt: 'later',
      updatedAt: 'later',
    }),
  ).toMatchObject({ createdAt: 'first', updatedAt: 'later' });
  await repo.removeTokens(winner, ['shared', 'shared']);
  expect(await repo.list(winner)).toHaveLength(0);
});
