import { generateKeyPairSync } from 'node:crypto';
import { createServer, type Server as HttpServer } from 'node:http';
import { Server, ServerCredentials } from '@grpc/grpc-js';
import { createClient } from 'redis';
import type { Messaging } from 'firebase-admin/messaging';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { MapNearbyClient } from '../../src/notification/map-nearby.client.js';
import { NearbyWorker } from '../../src/notification/nearby.worker.js';
import { NearbySubscriptionService } from '../../src/notification/nearby-subscription.service.js';
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
    server: Server,
    authority: HttpServer;
  let mapRedis: ReturnType<typeof createClient>,
    map: MapNearbyClient,
    subscriptions: NearbySubscriptionService;
  let store: PostgresEventStore,
    delivery: PostEventHandler,
    worker: NearbyWorker,
    consumer: PostEventConsumer;
  const positions = new Map<number, Location>(),
    moving = new Map<number, '' | 'USER_MOVING' | 'MOVEMENT_UNCONFIRMED'>();
  const blocked = new Set<string>(),
    inactive = new Set<string>();
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
    // Deliberately different client coordinates: only authenticated Map locations may select recipients.
    await subscriptions.save(String(id), {
      enabled: true,
      locationConsent: true,
      latitude: 0,
      longitude: 0,
      capturedAt: new Date().toISOString(),
    });
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
    index = new NotificationRecipientIndex(mapRedis, source);
    index.start();
    server = new Server();
    registerNotificationGrpc(server, index);
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
    store = new PostgresEventStore(h.database);
    subscriptions = new NearbySubscriptionService(h.database);
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
        MATCH: 'map:notification-recipients:v1:*',
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
    at(9);
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
      /latitude|longitude|subscriptionRevision|authorizationActorId/,
    );
    expect(
      (
        await h.database.pool.query(
          'SELECT status FROM notification_deliveries',
        )
      ).rows,
    ).toEqual([{ status: 'SENT' }]);
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
  it('distinguishes an explicitly reconciled empty consent list from an unavailable index', async () => {
    at(2);
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
    await map.ensureIndex(h.database);
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
    await map.ensureIndex(h.database);
    const active = await mapRedis.get('map:notification-recipients:v1:active');
    await mapRedis.del(`map:notification-recipients:v1:snapshot:${active}`);
    await expect(worker.runOnce()).rejects.toThrow();
    await retry();
    const held = vi.spyOn(delivery, 'dispatch').mockResolvedValue();
    await worker.runOnce();
    expect(await items()).toHaveLength(1);
    await subscriptions.remove('2');
    held.mockRestore();
    await delivery.dispatch();
    expect(sendEachForMulticast).not.toHaveBeenCalled();
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
