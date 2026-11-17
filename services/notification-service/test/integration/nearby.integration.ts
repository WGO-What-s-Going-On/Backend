import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { NearbySubscriptionService } from '../../src/notification/nearby-subscription.service.js';
import { NearbyWorker } from '../../src/notification/nearby.worker.js';
import { distanceM } from '../../src/notification/nearby.policy.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { NotificationBlockChecker } from '../../src/notification/block-checker.js';
import { parsePostEvent } from '../../src/event-consumer/post-event.js';
import { wire } from '../helpers/post-events.js';
import type { MapNearbyClient } from '../../src/notification/map-nearby.client.js';

describe('explicit 150m nearby subscriptions and bounded durable fanout', () => {
  let h: Awaited<ReturnType<typeof harness>>,
    subscriptions: NearbySubscriptionService,
    store: PostgresEventStore,
    worker: NearbyWorker,
    delivery: PostEventHandler;
  const allowed = vi.fn(),
    send = vi.fn();
  // Map owns spatial selection now. These existing tests retain their consent/delivery assertions.
  const map = {
    ensureIndex: async () => {},
    find: async (input: {
      latitude: number;
      longitude: number;
      participationRadiusM: number;
      authorId: string;
      afterUserId: string;
    }) => {
      const rows = (
        await h.database.pool.query(
          `SELECT * FROM notification_nearby_subscriptions
        WHERE expires_at>now() AND user_id COLLATE "C">$1 COLLATE "C" ORDER BY user_id COLLATE "C"`,
          [input.afterUserId],
        )
      ).rows.filter(
        (r) =>
          r.user_id !== input.authorId &&
          distanceM(input.latitude, input.longitude, r.latitude, r.longitude) <=
            Math.min(150, input.participationRadiusM) + 0.000001,
      );
      return {
        users: rows
          .slice(0, 50)
          .map((r) => ({ userId: r.user_id, revision: r.revision })),
        nextAfterUserId: rows.length > 50 ? rows[49].user_id : '',
      };
    },
  } as unknown as MapNearbyClient;
  const location = (latitude = 37.5, longitude = 127) => ({
    enabled: true,
    locationConsent: true,
    latitude,
    longitude,
    capturedAt: new Date().toISOString(),
  });
  const create = async (postId = 'post_nearby') =>
    store.apply(parsePostEvent(wire('PostCreated', { postId }).data)!);
  const items = async (userId = '2') =>
    (await h.notifications.list(userId, 100)).items;
  beforeEach(async () => {
    vi.stubEnv('NEARBY_NOTIFICATIONS_ENABLED', 'true');
    h = await harness();
    subscriptions = new NearbySubscriptionService(h.database);
    store = new PostgresEventStore(h.database);
    allowed.mockReset().mockResolvedValue(true);
    send.mockReset().mockResolvedValue({
      attempted: 1,
      succeeded: 1,
      failed: 0,
      invalidTokens: [],
      retryTokens: [],
    });
    const blocks = { allowed } as unknown as NotificationBlockChecker;
    delivery = new PostEventHandler(
      store,
      h.state,
      { send },
      undefined,
      blocks,
    );
    worker = new NearbyWorker(
      h.database,
      new NotificationEventWriter(h.database),
      blocks,
      h.state,
      delivery,
      h.config,
      map,
    );
  });
  afterEach(async () => {
    await worker.onModuleDestroy();
    await h.cleanup();
    vi.unstubAllEnvs();
  });
  it('requires separate consent and fresh locations, defaults OFF and never returns coordinates', async () => {
    for (const body of [
      { ...location(), locationConsent: false },
      {
        ...location(),
        capturedAt: new Date(Date.now() - 900001).toISOString(),
      },
      { ...location(), latitude: 91 },
      { ...location(), expiresInSeconds: 901 },
    ])
      await expect(subscriptions.save('2', body)).rejects.toMatchObject({
        status: 400,
      });
    expect(await subscriptions.save('2', location())).toMatchObject({
      enabled: true,
      locationConsent: true,
      radiusM: 150,
    });
    expect(await subscriptions.get('2')).not.toHaveProperty('latitude');
    vi.stubEnv('NEARBY_NOTIFICATIONS_ENABLED', 'false');
    await expect(subscriptions.save('3', location())).rejects.toMatchObject({
      status: 503,
    });
    await create();
    expect(
      (await h.database.pool.query('SELECT * FROM notification_nearby_jobs'))
        .rowCount,
    ).toBe(0);
  });
  it('uses an inclusive 150m radius, excludes author and blocked recipients, and throttles separate posts', async () => {
    const north = (metres: number) =>
      37.5 + ((metres / 6371000) * 180) / Math.PI;
    expect(distanceM(37.5, 127, north(150), 127)).toBeCloseTo(150, 6);
    for (const [id, metres] of [
      ['1', 0],
      ['2', 150],
      ['3', 150.01],
      ['4', 20],
    ] as const)
      await subscriptions.save(id, location(north(metres)));
    allowed.mockImplementation(async (id: string) => id !== '4');
    await create();
    await worker.runOnce();
    expect(await items('2')).toHaveLength(1);
    expect((await items('2'))[0]?.actorId).toBeNull();
    expect((await items('2'))[0]?.metadata).toBeUndefined();
    expect(await items('1')).toHaveLength(0);
    expect(await items('3')).toHaveLength(0);
    expect(await items('4')).toHaveLength(0);
    expect(send).toHaveBeenCalledOnce();
    expect(JSON.stringify(send.mock.calls[0]?.[0])).not.toContain('latitude');
    await create('post_next');
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });
  it('stops enqueuing on authority failure and safely resumes the same durable job', async () => {
    await subscriptions.save('2', location());
    await create();
    allowed.mockRejectedValueOnce(new Error('User unavailable'));
    await expect(worker.runOnce()).rejects.toThrow('User unavailable');
    expect(await items()).toHaveLength(0);
    await h.database.pool.query(
      'UPDATE notification_nearby_jobs SET next_attempt_at=now()',
    );
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
    expect(send).toHaveBeenCalledOnce();
  });
  it('cancels unsent pushes on opt-out, refresh and expiry while preserving inbox history', async () => {
    await subscriptions.save('2', location());
    await create();
    const dispatch = vi.spyOn(delivery, 'dispatch').mockResolvedValue();
    await worker.runOnce();
    expect(await store.deliveries()).toHaveLength(1);
    await subscriptions.remove('2');
    expect(await store.deliveries()).toHaveLength(0);
    expect(await items()).toHaveLength(1);
    dispatch.mockRestore();
    await delivery.dispatch();
    expect(send).not.toHaveBeenCalled();
    await subscriptions.save('2', location());
    await h.database.pool.query(
      "UPDATE notification_nearby_subscriptions SET expires_at=now()-interval '1 second'",
    );
    await worker.cleanupExpired();
    expect(
      (
        await h.database.pool.query(
          'SELECT * FROM notification_nearby_subscriptions',
        )
      ).rowCount,
    ).toBe(0);
  });
  it('cancels a fanout job after actual deletion and never reactivates it from a late creation', async () => {
    await subscriptions.save('2', location());
    await create();
    await store.apply(
      parsePostEvent(wire('PostDeleted', { postId: 'post_nearby' }).data)!,
    );
    await worker.runOnce();
    await create();
    await worker.runOnce();
    expect(await items()).toHaveLength(0);
    expect(send).not.toHaveBeenCalled();
  });
  it('preserves user and board preferences', async () => {
    await subscriptions.save('2', location());
    await subscriptions.save('3', location());
    await store.savePreferences('2', { nearby: false });
    await store.setBoardPreference('3', 'post_nearby', false);
    await create();
    await worker.runOnce();
    expect(await items('2')).toHaveLength(0);
    expect(await items('3')).toHaveLength(0);
  });
  it('pages 115 recipients across worker restarts without unbounded fanout or duplicate pushes', async () => {
    await h.database.pool
      .query(`INSERT INTO notification_nearby_subscriptions(user_id,revision,latitude,longitude,captured_at,expires_at)
    SELECT n::text,n::text,37.5,127,now(),now()+interval '15 minutes' FROM generate_series(100,214) n`);
    await create();
    await worker.runOnce();
    expect(
      (await h.database.pool.query('SELECT * FROM notifications')).rowCount,
    ).toBe(50);
    const other = new NearbyWorker(
      h.database,
      new NotificationEventWriter(h.database),
      { allowed } as unknown as NotificationBlockChecker,
      h.state,
      delivery,
      h.config,
      map,
    );
    await Promise.all([worker.runOnce(), other.runOnce()]);
    expect(
      (await h.database.pool.query('SELECT * FROM notifications')).rowCount,
    ).toBe(100);
    await other.runOnce();
    expect(
      (await h.database.pool.query('SELECT * FROM notifications')).rowCount,
    ).toBe(115);
    expect(send).toHaveBeenCalledTimes(115);
    await create();
    await worker.runOnce();
    expect(send).toHaveBeenCalledTimes(115);
  });
});
