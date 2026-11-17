import { generateKeyPairSync, sign } from 'node:crypto';
import {
  Server,
  ServerCredentials,
  credentials,
  Metadata,
  loadPackageDefinition,
  status,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { createClient } from 'redis';
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { NotificationRecipientIndex } from '../src/notification-recipient-index.js';
import { registerNotificationGrpc } from '../src/notification-grpc.js';
import {
  notificationLocationSaved,
  onNotificationLocationSaved,
} from '../src/notification-location-events.js';
import { CassandraLocationStore } from '../src/store.js';
import { registerNotificationRecipients } from '../src/notification-runtime.js';
import { createHttpServer } from '../src/server.js';
import type { Location, LocationStore } from '../src/location.js';
import type { MovementState } from '../src/movement.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('additive opt-in recipient index: real Redis, gRPC and Cassandra', () => {
  const redis = createClient({
    url: 'redis://127.0.0.1:6381/11',
    socket: { reconnectStrategy: false },
  });
  const locations = new Map<number, Location>();
  const reasons = new Map<number, MovementState['reason']>();
  const source: LocationStore = {
    async put(id, value) {
      locations.set(id, value);
      return value;
    },
    async get(id) {
      return locations.get(id) ?? null;
    },
    async movement(id) {
      const location = locations.get(id);
      return location
        ? { location, stop: location, reason: reasons.get(id) ?? '' }
        : null;
    },
  };
  let index: NotificationRecipientIndex, server: Server, client: any;
  const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const consent = (id: number, expires = Date.now() + 60000) => ({
    userId: String(id),
    revision: `revision-${id}`,
    expiresAtMs: String(expires),
  });
  const at = (id: number, metres = 0, age = 0) =>
    locations.set(id, {
      latitude: 37.5 + ((metres / 6371008.8) * 180) / Math.PI,
      longitude: 127,
      updatedAt: new Date(Date.now() - age),
    });
  const query = (radius = 150, afterUserId = '') => ({
    latitude: 37.5,
    longitude: 127,
    participationRadiusM: radius,
    authorId: '1',
    limit: 50,
    afterUserId,
  });
  const publish = async (ids: number[]) => {
    const snapshot = await index.begin(ids.length);
    for (let n = 0; n < ids.length; n += 50)
      await index.add(
        snapshot,
        ids.slice(n, n + 50).map((id) => consent(id)),
      );
    await index.publish(snapshot);
    return snapshot;
  };
  function metadata(claims = {}, alg = 'ES256') {
    const now = Math.floor(Date.now() / 1000);
    const h = Buffer.from(
      JSON.stringify({ alg, typ: 'wgo-service+jwt', kid: 'notification-qa' }),
    ).toString('base64url');
    const p = Buffer.from(
      JSON.stringify({
        iss: 'wgo-notification-service',
        sub: 'notification-service',
        aud: 'wgo-map-service',
        iat: now,
        exp: now + 30,
        ...claims,
      }),
    ).toString('base64url');
    const s = sign('sha256', Buffer.from(`${h}.${p}`), {
      key: pair.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const m = new Metadata();
    m.set('authorization', `Bearer ${h}.${p}.${s}`);
    return m;
  }
  const rpc = (method: string, input: unknown, m = metadata()) =>
    new Promise<any>((resolve, reject) =>
      client[method](
        input,
        m,
        { deadline: Date.now() + 3000 },
        (error: any, result: any) => (error ? reject(error) : resolve(result)),
      ),
    );
  beforeAll(async () => {
    await redis.connect();
    vi.stubEnv(
      'MAP_NOTIFICATION_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...pair.publicKey.export({ format: 'jwk' }),
            alg: 'ES256',
            kid: 'notification-qa',
            iss: 'wgo-notification-service',
          },
        ],
      }),
    );
    index = new NotificationRecipientIndex(redis, source);
    server = new Server();
    registerNotificationGrpc(server, index);
    const port = await new Promise<number>((resolve, reject) =>
      server.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (e, p) => (e ? reject(e) : resolve(p)),
      ),
    );
    const pkg = loadPackageDefinition(
      loadSync('contracts/map-notification.proto', {
        longs: String,
        arrays: true,
        defaults: true,
      }),
    ) as any;
    client = new pkg.wgo.map.notifications.v1.MapNotificationRecipients(
      `127.0.0.1:${port}`,
      credentials.createInsecure(),
    );
  });
  beforeEach(async () => {
    locations.clear();
    reasons.clear();
    for await (const keys of redis.scanIterator({
      MATCH: 'map:notification-recipients:v1:*',
    }))
      if (keys.length) await redis.del(keys);
  });
  afterAll(async () => {
    client?.close();
    server?.forceShutdown();
    await index?.close();
    for await (const keys of redis.scanIterator({
      MATCH: 'map:notification-recipients:v1:*',
    }))
      if (keys.length) await redis.del(keys);
    await redis.quit();
    vi.unstubAllEnvs();
  });
  it('requires Notification-only ES256 and validates the new request without touching legacy auth', async () => {
    for (const m of [
      new Metadata(),
      metadata({ aud: 'wgo-user-service' }),
      metadata({ sub: 'post-service', iss: 'wgo-post-service' }),
      metadata({}, 'HS256'),
      metadata({ exp: 1 }),
    ])
      await expect(rpc('findNearbyUsers', query(), m)).rejects.toMatchObject({
        code: status.UNAUTHENTICATED,
      });
    await expect(
      rpc('findNearbyUsers', { ...query(), latitude: 91 }),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(rpc('findNearbyUsers', query())).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
  });
  it('keeps the existing location API available when new notification configuration is invalid', async () => {
    const original = process.env.MAP_NOTIFICATION_TRUSTED_JWKS;
    vi.stubEnv('MAP_NEARBY_NOTIFICATIONS_ENABLED', 'true');
    vi.stubEnv('MAP_NOTIFICATION_TRUSTED_JWKS', 'invalid');
    const existing = createHttpServer(source);
    const stop = registerNotificationRecipients(new Server(), source);
    await new Promise<void>((resolve) =>
      existing.listen(0, '127.0.0.1', resolve),
    );
    try {
      const response = await fetch(
        `http://127.0.0.1:${(existing.address() as any).port}/api/v1/location`,
        {
          method: 'PUT',
          headers: { 'content-type': 'application/json', 'x-user-id': '42' },
          body: JSON.stringify({ latitude: 37.5, longitude: 127 }),
        },
      );
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({
        latitude: 37.5,
        longitude: 127,
      });
    } finally {
      await stop();
      await new Promise<void>((resolve) => existing.close(() => resolve()));
      vi.stubEnv('MAP_NEARBY_NOTIFICATIONS_ENABLED', 'false');
      vi.stubEnv('MAP_NOTIFICATION_TRUSTED_JWKS', original ?? '');
    }
  });
  it('uses min(150m, actual radius), five-minute freshness, movement and explicit consent', async () => {
    at(1);
    at(2, 149.999999);
    at(3, 150.01);
    at(4, 20, 300001);
    at(5, 20);
    at(6, 20);
    at(7, 20, -6000);
    at(8, 20);
    reasons.set(5, 'USER_MOVING');
    reasons.set(6, 'MOVEMENT_UNCONFIRMED');
    await publish([1, 2, 3, 4, 5, 6, 7]);
    expect((await rpc('findNearbyUsers', query())).users).toEqual([
      { userId: '2', revision: 'revision-2' },
    ]);
    expect((await index.find(query(50))).users).toEqual([]);
    // An unregistered user with a valid Map position never acquires notification consent.
    expect(JSON.stringify(await index.find(query()))).not.toContain(
      'revision-8',
    );
  });
  it('pages deterministically without duplicates, including an empty completed page', async () => {
    const ids = Array.from({ length: 115 }, (_, i) => i + 100);
    ids.forEach((id) => at(id));
    await publish(ids);
    const seen: string[] = [];
    let cursor = '';
    do {
      const page = await rpc('findNearbyUsers', query(150, cursor));
      seen.push(...page.users.map((u: any) => u.userId));
      cursor = page.nextAfterUserId;
    } while (cursor);
    expect(seen).toHaveLength(115);
    expect(new Set(seen).size).toBe(115);
    await publish([]);
    expect((await rpc('findNearbyUsers', query())).users).toEqual([]);
  });
  it('finds users across the date line and near the poles without changing coordinate policy', async () => {
    for (const [center, location] of [
      [
        { latitude: 0, longitude: 179.9998 },
        { latitude: 0, longitude: -179.9998 },
      ],
      [
        { latitude: 89.9998, longitude: 0 },
        { latitude: 89.9998, longitude: 180 },
      ],
    ]) {
      locations.set(2, { ...location!, updatedAt: new Date() });
      await publish([2]);
      expect(
        (await index.find({ ...query(), ...center! })).users[0]?.userId,
      ).toBe('2');
    }
  });
  it('preserves published data on restart and refuses incomplete, lost and expired snapshots', async () => {
    at(2);
    const id = await publish([2]);
    expect(
      (await new NotificationRecipientIndex(redis, source).find(query())).users,
    ).toHaveLength(1);
    const incomplete = await index.begin(2);
    await index.add(incomplete, [consent(2)]);
    await expect(index.publish(incomplete)).rejects.toThrow('Incomplete');
    await redis.del(`map:notification-recipients:v1:snapshot:${id}`);
    await expect(rpc('findNearbyUsers', query())).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
    const rebuilt = await publish([2]);
    await redis.pExpire(
      `map:notification-recipients:v1:snapshot:${rebuilt}`,
      1,
    );
    await new Promise((r) => setTimeout(r, 5));
    await expect(index.find(query())).rejects.toThrow('unavailable');
    await publish([2]);
    expect((await index.find(query())).users).toHaveLength(1);
  });
  it('bounds dense-cell work and advances through pages containing no eligible user', async () => {
    const ids = Array.from({ length: 50 }, (_, i) => 100 + i);
    ids.forEach((id) => at(id, 200));
    at(999);
    await publish([...ids, 999]);
    const first = await index.find(query());
    expect(first.users).toEqual([]);
    expect(first.nextAfterUserId).toBe('149');
    expect(
      (await index.find(query(150, first.nextAfterUserId))).users[0]?.userId,
    ).toBe('999');
  });
  it('detects cell corruption and rechecks consent expiry and latest positions at query time', async () => {
    at(2);
    const id = await publish([2]);
    const key = `map:notification-recipients:v1:snapshot:${id}`;
    const fields = await redis.hKeys(key);
    const cell = fields
      .find((f) => f.startsWith('count:'))!
      .slice('count:'.length);
    await redis.del(`${key}:cell:${cell}`);
    await expect(rpc('findNearbyUsers', query())).rejects.toMatchObject({
      code: status.UNAVAILABLE,
    });
    await publish([2]);
    at(2, 200);
    expect((await index.find(query())).users).toEqual([]);
    at(2);
    const expired = await index.begin(1);
    await index.add(expired, [consent(2, Date.now() - 1)]);
    await index.publish(expired);
    expect((await index.find(query())).users).toEqual([]);
  });
  it('refreshes opted-in users after location saves without indexing nonconsenting users', async () => {
    at(2, 2000);
    at(3);
    await publish([2]);
    index.start();
    at(2);
    notificationLocationSaved(2);
    notificationLocationSaved(3);
    expect((await index.find(query())).users).toEqual([
      { userId: '2', revision: 'revision-2' },
    ]);
    at(2, 2000);
    notificationLocationSaved(2);
    expect((await index.find(query())).users).toEqual([]);
    await index.close();
  });
  it('uses the unchanged Cassandra location write and adds only the opt-in index update', async () => {
    const store = new CassandraLocationStore();
    await store.connect();
    const actual = new NotificationRecipientIndex(redis, store);
    actual.start();
    const stopBrokenObserver = onNotificationLocationSaved(() => {
      throw new Error('Observer offline');
    });
    const userId = 700000000 + Math.floor(Math.random() * 1000000);
    try {
      const saved = await store.put(userId, {
        latitude: 37.5,
        longitude: 127,
        updatedAt: new Date(),
      });
      await store.cache.del(`map:location:${userId}`);
      const id = await actual.begin(1);
      await actual.add(id, [consent(userId)]);
      await actual.publish(id);
      expect((await actual.find(query())).users[0]?.userId).toBe(
        String(userId),
      );
      expect(await store.get(userId)).toMatchObject(saved);
      expect((await store.movement(userId))?.reason).toBe('');
    } finally {
      stopBrokenObserver();
      await actual.close();
      await store.close();
    }
  });
});
