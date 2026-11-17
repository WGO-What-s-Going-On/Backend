import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server, ServerCredentials } from '@grpc/grpc-js';
import { createClient } from 'redis';
import type { Messaging } from 'firebase-admin/messaging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { wire } from '../helpers/post-events.js';
import { harness } from './harness.js';
import { NearbyEligibilityClient } from '../../src/notification/nearby-eligibility.client.js';
import { MapNearbyClient } from '../../src/notification/map-nearby.client.js';
import { NearbyWorker } from '../../src/notification/nearby.worker.js';
import { NotificationEventWriter } from '../../src/persistence/notification-event.writer.js';
import { NotificationBlockChecker } from '../../src/notification/block-checker.js';
import { PostgresEventStore } from '../../src/persistence/postgres-event.store.js';
import { PostEventHandler } from '../../src/event-consumer/post-event.handler.js';
import { PostEventConsumer } from '../../src/event-consumer/post-event.consumer.js';
import { FirebasePushAdapter } from '../../src/firebase/firebase-push.adapter.js';
// Load the separately built service only at test runtime; it is not a Notification production dependency.
const mapSource = new URL('../../../map-service/src/', import.meta.url);
const postSource = new URL('../../../post-service/src/post/', import.meta.url);
type Location = { latitude: number; longitude: number; updatedAt: Date };

describe('PostCreated → actual Map gRPC → PostgreSQL inbox/delivery → Firebase adapter', () => {
  let h: Awaited<ReturnType<typeof harness>>,
    index: any,
    legacyIndex: any,
    server: Server,
    authority: HttpServer;
  let mapRedis: ReturnType<typeof createClient>, map: MapNearbyClient;
  let store: PostgresEventStore,
    delivery: PostEventHandler,
    worker: NearbyWorker,
    consumer: PostEventConsumer;
  const positions = new Map<number, Location>(),
    moving = new Map<number, '' | 'USER_MOVING' | 'MOVEMENT_UNCONFIRMED'>();
  const blocked = new Set<string>(),
    inactive = new Set<string>(),
    revoked = new Set<string>();
  const sendEachForMulticast = vi.fn();
  const source = {
    async get(id: number) {
      return positions.get(id) ?? null;
    },
    async put(id: number, location: Location) {
      positions.set(id, location);
      return location;
    },
    async movement(id: number) {
      const location = positions.get(id);
      return location
        ? { location, stop: location, reason: moving.get(id) ?? '' }
        : null;
    },
  };
  function at(id: number, metres = 0, age = 0) {
    positions.set(id, {
      latitude: 37.5 + ((metres / 6371008.8) * 180) / Math.PI,
      longitude: 127,
      updatedAt: new Date(Date.now() - age),
    });
  }
  async function subscribe(id: number, metres = 0, age = 0) {
    at(id, metres, age);
    // Populate Map through its existing success hook; no nearby subscription is registered.
    const { notificationLocationSaved } = await import(
      new URL('notification-location-events.ts', mapSource).href
    );
    notificationLocationSaved(id);
    await h.subscriptions.upsert(String(id), `qa-token-${id}`, 'web');
    h.ownedKeys.add(`notification:unread:${id}`);
  }
  async function post(radius = 150) {
    // Exercise the actual Post command and outbox serializer, with only its database/authorization ports replaced.
    const { CreatePost } = await import(
      new URL('application/commands.ts', postSource).href
    );
    const { serializePostEvent } = await import(
      new URL('infrastructure/post-event-envelope.ts', postSource).href
    );
    let outbox: any;
    const command = new CreatePost(
      {
        execute: async (work: any) =>
          work({
            commands: {
              insertPost: async () => {},
              appendEvent: async (value: any) => {
                outbox = value;
              },
            },
          }),
      },
      {
        assertCanCreate: async () => {},
        resolveRegion: async () => ({
          code: '1168058000',
          name: 'test-region',
        }),
      },
    );
    await command.execute(
      {
        title: 'QA nearby',
        content: 'Local integration',
        category: 'INCIDENT',
        latitude: 37.5,
        longitude: 127,
        radiusM: radius,
      },
      1,
    );
    const fields = {
      eventId: outbox.eventId as string,
      eventType: outbox.eventType as string,
      data: serializePostEvent(outbox) as string,
    };
    await index.flush();
    await mapRedis.hSet(
      'map:nearby-location:v1:state',
      'born',
      String(Date.now() - 300001),
    );
    await h.redis.xAdd('post:events', '*', fields);
    await consumer.pollOnce();
    return fields;
  }
  const items = async (id = '2') => (await h.notifications.list(id, 100)).items;
  const retry = () =>
    h.database.pool.query(
      'UPDATE notification_nearby_jobs SET next_attempt_at=now()',
    );
  beforeEach(async () => {
    vi.stubEnv('NEARBY_NOTIFICATIONS_ENABLED', 'true');
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    vi.stubEnv(
      'NOTIFICATION_SERVICE_PRIVATE_JWK',
      JSON.stringify({
        ...pair.privateKey.export({ format: 'jwk' }),
        alg: 'ES256',
        kid: 'qa-notification',
      }),
    );
    vi.stubEnv(
      'MAP_NOTIFICATION_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            alg: 'ES256',
            kid: 'qa-notification',
            iss: 'wgo-notification-service',
          },
        ],
      }),
    );
    positions.clear();
    moving.clear();
    blocked.clear();
    inactive.clear();
    revoked.clear();
    h = await harness();
    ['post:events', 'notification:post:dead'].forEach((k) =>
      h.ownedKeys.add(k),
    );
    const mapRedisUrl = new URL(h.config.get<string>('redis.url')!);
    mapRedisUrl.pathname = '/14';
    mapRedis = createClient({
      url: mapRedisUrl.toString(),
      socket: { reconnectStrategy: false },
    });
    await mapRedis.connect();
    const { NotificationRecipientIndex } = await import(
      new URL('notification-recipient-index.ts', mapSource).href
    );
    const { registerNotificationGrpc } = await import(
      new URL('notification-grpc.ts', mapSource).href
    );
    const { LocationGeoIndex } = await import(
      new URL('location-geo-index.ts', mapSource).href
    );
    legacyIndex = new NotificationRecipientIndex(mapRedis, source);
    index = new LocationGeoIndex(mapRedis, source);
    index.start();
    server = new Server();
    registerNotificationGrpc(server, legacyIndex, index);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (e, p) => (e ? reject(e) : resolve(p)),
      ),
    );
    vi.stubEnv('MAP_GRPC_ADDRESS', `127.0.0.1:${port}`);
    authority = createServer(async (req, res) => {
      let raw = '';
      for await (const part of req) raw += part;
      const input = JSON.parse(raw);
      res.setHeader('content-type', 'application/json');
      if (req.url === '/internal/notifications/nearby/eligibility') {
        res.end(
          JSON.stringify({
            users: input.userIds.map((userId: string) => ({
              userId,
              eligible: !revoked.has(userId) && !inactive.has(userId),
            })),
          }),
        );
        return;
      }
      res.end(
        JSON.stringify({
          recipientId: input.recipientId,
          recipientActive: !inactive.has(input.recipientId),
          actors: input.actorIds.map((actorId: string) => ({
            actorId,
            blocked: blocked.has(input.recipientId),
          })),
        }),
      );
    });
    await new Promise<void>((resolve) =>
      authority.listen(0, '127.0.0.1', resolve),
    );
    vi.stubEnv(
      'NOTIFICATION_USER_BLOCKS_URL',
      `http://127.0.0.1:${(authority.address() as any).port}/internal/notification-blocks`,
    );
    const blocks = new NotificationBlockChecker(h.config);
    const eligibility = new NearbyEligibilityClient(h.config);
    store = new PostgresEventStore(h.database);
    sendEachForMulticast.mockReset().mockResolvedValue({
      successCount: 1,
      failureCount: 0,
      responses: [{ success: true }],
    });
    const firebase = new FirebasePushAdapter(h.config, h.subscriptions, {
      sendEachForMulticast,
    } as unknown as Messaging);
    delivery = new PostEventHandler(
      store,
      h.state,
      firebase,
      undefined,
      blocks,
      eligibility,
    );
    map = new MapNearbyClient();
    worker = new NearbyWorker(
      h.database,
      new NotificationEventWriter(h.database),
      blocks,
      h.state,
      delivery,
      h.config,
      map,
      eligibility,
    );
    consumer = new PostEventConsumer(h.config, delivery, undefined, h.database);
    await consumer.worker!.initialize();
  });
  afterEach(async () => {
    await worker?.onModuleDestroy();
    await consumer?.onModuleDestroy();
    map?.onModuleDestroy();
    server?.forceShutdown();
    await index?.close();
    if (authority)
      await new Promise<void>((resolve) => authority.close(() => resolve()));
    if (mapRedis?.isOpen) {
      for await (const keys of mapRedis.scanIterator({
        MATCH: 'map:nearby-location:v1:*',
      }))
        if (keys.length) await mapRedis.del(keys);
      await mapRedis.quit();
    }
    await h?.cleanup();
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });
  it('consumes and ACKs PostCreated, queries Map, excludes invalid recipients and sends one safe push', async () => {
    await subscribe(1);
    await subscribe(2, 149.999999);
    await subscribe(3, 150.01);
    await subscribe(4);
    await subscribe(5);
    await subscribe(6, 0, 300001);
    await subscribe(7);
    moving.set(7, 'USER_MOVING');
    await subscribe(8);
    moving.set(8, 'MOVEMENT_UNCONFIRMED');
    await subscribe(9);
    revoked.add('9');
    blocked.add('4');
    inactive.add('5');
    const fields = await post();
    await worker.runOnce();
    expect(
      (await h.redis.xPending('post:events', 'post-notification')).pending,
    ).toBe(0);
    expect(await items()).toHaveLength(1);
    for (const id of ['1', '3', '4', '5', '6', '7', '8', '9'])
      expect(await items(id)).toHaveLength(0);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
    const push = sendEachForMulticast.mock.calls[0]![0];
    expect(push.tokens).toEqual(['qa-token-2']);
    expect(push.data.type).toBe('NEARBY_POST_CREATED');
    expect(JSON.stringify(push)).not.toMatch(
      /latitude|longitude|subscriptionRevision|authorizationActorId|nearbyAudiencePolicy|nearbyExpiresAt/,
    );
    expect(
      (
        await h.database.pool.query(
          'SELECT status FROM notification_deliveries',
        )
      ).rows,
    ).toEqual([{ status: 'SENT' }]);
    await consumer.onModuleDestroy();
    consumer = new PostEventConsumer(h.config, delivery, undefined, h.database);
    await consumer.worker!.initialize();
    await h.redis.xAdd('post:events', '*', fields);
    await consumer.pollOnce();
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });
  it('honors actual participation radius and existing user/board settings', async () => {
    await subscribe(2, 75);
    await subscribe(3, 25);
    await subscribe(4, 25);
    await subscribe(5, 25);
    await store.savePreferences('3', { nearby: false });
    const fields = await post(50);
    await store.setBoardPreference(
      '4',
      JSON.parse(fields.data).aggregateId,
      false,
    );
    await worker.runOnce();
    for (const id of ['2', '3', '4']) expect(await items(id)).toHaveLength(0);
    expect(await items('5')).toHaveLength(1);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });
  it('distinguishes a ready empty GEO from an unavailable index', async () => {
    await post();
    await worker.runOnce();
    expect(await items()).toHaveLength(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    expect(
      (
        await h.database.pool.query(
          'SELECT status FROM notification_nearby_jobs',
        )
      ).rows,
    ).toEqual([{ status: 'DONE' }]);
  });
  it('retains the durable job on Map gRPC failure and recovers without losing or duplicating delivery', async () => {
    await subscribe(2);
    await post();
    const find = vi
      .spyOn(index, 'find')
      .mockRejectedValueOnce(new Error('Map dependency offline'));
    await expect(worker.runOnce()).rejects.toThrow();
    expect(
      (
        await h.database.pool.query(
          'SELECT status,cursor_user_id FROM notification_nearby_jobs',
        )
      ).rows,
    ).toEqual([{ status: 'PENDING', cursor_user_id: '' }]);
    expect(await items()).toHaveLength(0);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    find.mockRestore();
    await retry();
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
  });
  it('rebuilds after Redis index loss and respects withdrawal before FCM dispatch', async () => {
    await subscribe(2);
    await post();
    await mapRedis.del('map:nearby-location:v1:geo');
    await expect(worker.runOnce()).rejects.toThrow();
    await subscribe(2);
    await index.flush();
    await mapRedis.hSet(
      'map:nearby-location:v1:state',
      'born',
      String(Date.now() - 300001),
    );
    await retry();
    const held = vi.spyOn(delivery, 'dispatch').mockResolvedValue();
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
    revoked.add('2');
    held.mockRestore();
    await delivery.dispatch();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
  it.each([150, 250, 350])(
    'keeps the original %im radius across retry and includes defaults',
    async (radius) => {
      await subscribe(2, radius - 0.001);
      await subscribe(3, radius + 0.001);
      await subscribe(4, radius - 0.001);
      await subscribe(5, radius - 0.001);
      await subscribe(6, radius - 0.001);
      await store.savePreferences('4', { nearby: true });
      await store.savePreferences('5', { nearby: false });
      await store.savePreferences('6', { replies: false });
      await post(radius);
      vi.spyOn(index, 'find').mockRejectedValueOnce(new Error('timeout'));
      await expect(worker.runOnce()).rejects.toThrow();
      expect(
        (
          await h.database.pool.query(
            'SELECT participation_radius_m FROM notification_nearby_job_policy',
          )
        ).rows,
      ).toEqual([{ participation_radius_m: radius }]);
      await retry();
      await worker.runOnce();
      for (const id of ['2', '4', '6']) expect(await items(id)).toHaveLength(1);
      for (const id of ['3', '5']) expect(await items(id)).toHaveLength(0);
      expect(
        (
          await h.database.pool.query(
            'SELECT * FROM notification_nearby_subscriptions',
          )
        ).rows,
      ).toHaveLength(0);
    },
  );
  it('cancels a queued nearby push when its job window expires', async () => {
    await subscribe(2);
    await post();
    const held = vi.spyOn(delivery, 'dispatch').mockResolvedValue();
    await worker.runOnce();
    held.mockRestore();
    await h.database.pool.query(
      `UPDATE notification_deliveries SET message=jsonb_set(message,'{data,nearbyExpiresAt}','"2000-01-01T00:00:00.000Z"')`,
    );
    await delivery.dispatch();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
  });
  it.each(['PostDeleted', 'PostExpired', 'PostHidden'] as const)(
    'cancels nearby delivery on %s',
    async (type) => {
      await subscribe(2);
      const fields = await post();
      const held = vi.spyOn(delivery, 'dispatch').mockResolvedValue();
      await worker.runOnce();
      await h.redis.xAdd(
        'post:events',
        '*',
        wire(type, { postId: JSON.parse(fields.data).aggregateId }),
      );
      await consumer.pollOnce();
      held.mockRestore();
      await delivery.dispatch();
      expect(sendEachForMulticast).not.toHaveBeenCalled();
    },
  );
  it('retries an authoritative consent outage without guessing eligibility', async () => {
    await subscribe(2);
    await post();
    const check = vi
      .spyOn(NearbyEligibilityClient.prototype, 'eligible')
      .mockRejectedValueOnce(new Error('User offline'));
    await expect(worker.runOnce()).rejects.toThrow('User offline');
    expect(await items()).toHaveLength(0);
    check.mockRestore();
    await retry();
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
  });
  it('retains the job on a real gRPC deadline and succeeds on retry', async () => {
    await subscribe(2);
    await post();
    const slow = vi
      .spyOn(index, 'find')
      .mockImplementationOnce(async (_input: unknown, check: any) => {
        await new Promise((resolve) => setTimeout(resolve, 2100));
        check();
        return { users: [], nextAfterUserId: '' };
      });
    await expect(worker.runOnce()).rejects.toThrow();
    slow.mockRestore();
    expect(
      (
        await h.database.pool.query(
          'SELECT status FROM notification_nearby_jobs',
        )
      ).rows,
    ).toEqual([{ status: 'PENDING' }]);
    await retry();
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
  });
  it('retains the inbox and delivery when the send-time consent check fails', async () => {
    await subscribe(2);
    await post();
    const held = vi.spyOn(delivery, 'dispatch').mockResolvedValue();
    await worker.runOnce();
    held.mockRestore();
    const failed = vi
      .spyOn(NearbyEligibilityClient.prototype, 'eligible')
      .mockRejectedValueOnce(new Error('User timeout'));
    await expect(delivery.dispatch()).rejects.toThrow('User timeout');
    failed.mockRestore();
    expect(await items()).toHaveLength(1);
    expect(sendEachForMulticast).not.toHaveBeenCalled();
    await h.database.pool.query(
      'UPDATE notification_deliveries SET next_attempt_at=0',
    );
    await delivery.dispatch();
    expect(sendEachForMulticast).toHaveBeenCalledOnce();
    expect(await items()).toHaveLength(1);
  });
  it('reuses existing FCM transient retry and idempotency without recreating the inbox', async () => {
    await subscribe(2);
    await post();
    sendEachForMulticast.mockResolvedValueOnce({
      successCount: 0,
      failureCount: 1,
      responses: [
        { success: false, error: { code: 'messaging/internal-error' } },
      ],
    });
    await expect(worker.runOnce()).rejects.toThrow();
    expect(await items()).toHaveLength(1);
    await h.database.pool.query(
      'UPDATE notification_deliveries SET next_attempt_at=0',
    );
    await delivery.dispatch();
    expect(sendEachForMulticast).toHaveBeenCalledTimes(2);
    expect(await items()).toHaveLength(1);
    expect(
      (
        await h.database.pool.query(
          'SELECT status FROM notification_deliveries',
        )
      ).rows,
    ).toEqual([{ status: 'SENT' }]);
  });
});
