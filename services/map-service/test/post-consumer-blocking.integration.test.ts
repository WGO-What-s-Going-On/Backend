import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { readFileSync } from 'node:fs';
import {
  createServer as createTcpServer,
  connect as tcpConnect,
  type Socket,
} from 'node:net';
import cassandra from 'cassandra-driver';
import { createClient } from 'redis';
import {
  credentials,
  loadPackageDefinition,
  Metadata,
  ServerCredentials,
  type Server,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { PostConsumer } from '../src/post-consumer.js';
import {
  DEAD_STREAM,
  POST_GROUP,
  POST_STREAM,
  PostIndex,
} from '../src/post-index.js';
import { createGrpcServer } from '../src/server.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'PostConsumer blocking connection isolation: real Redis, Cassandra and gRPC',
  () => {
    const redisUrl = 'redis://127.0.0.1:6381/9';
    const keyspace = `wgo_consumer_${randomUUID().replaceAll('-', '')}`;
    const admin = new cassandra.Client({
      contactPoints: ['127.0.0.1'],
      localDataCenter: 'datacenter1',
    });
    const control = createClient({
      url: redisUrl,
      socket: { reconnectStrategy: false },
    });
    const pair = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    let index: PostIndex, server: Server | undefined, client: any;
    const consumers: PostConsumer[] = [],
      runs: Promise<void>[] = [];
    const proxies: Array<() => Promise<void>> = [];
    async function until<T>(
      read: () => Promise<T | undefined | false>,
      timeout = 6000,
    ): Promise<T> {
      const end = Date.now() + timeout;
      while (Date.now() < end) {
        const value = await read();
        if (value) return value;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      throw new Error('Timed out waiting for consumer state');
    }
    async function connections() {
      const text = (await control.sendCommand(['CLIENT', 'LIST'])) as string;
      return text
        .trim()
        .split('\n')
        .map((line) =>
          Object.fromEntries(
            line.split(' ').map((part) => {
              const offset = part.indexOf('=');
              return [part.slice(0, offset), part.slice(offset + 1)];
            }),
          ),
        )
        .filter((connection) => connection.db === '9');
    }
    const blocked = () =>
      until(async () =>
        (await connections()).find(
          (c) => c.flags.includes('b') && c.cmd === 'xreadgroup',
        ),
      );
    function startConsumer() {
      const consumer = new PostConsumer(index);
      consumers.push(consumer);
      const running = consumer.run();
      void running.catch(() => undefined);
      runs.push(running);
      return consumer;
    }
    function created() {
      const postId = `post_${randomUUID()}`;
      return {
        eventId: `evt_${randomUUID()}`,
        eventType: 'PostCreated',
        schemaVersion: 1,
        producer: 'post-service',
        aggregateId: postId,
        occurredAt: new Date().toISOString(),
        post: {
          postId,
          authorId: 123,
          latitude: 37.5,
          longitude: 127,
          radiusM: 150,
          category: 'INCIDENT',
          expiresAt: null,
        },
      };
    }
    const publish = (event: ReturnType<typeof created> | Record<string, any>) =>
      control.xAdd(POST_STREAM, '*', {
        eventId: event.eventId,
        eventType: event.eventType,
        data: JSON.stringify(event),
      });
    async function acknowledged(id: string) {
      await until(async () => {
        const group = (await control.xInfoGroups(POST_STREAM)).find(
          (g) => g.name === POST_GROUP,
        );
        return group?.['last-delivered-id'] === id && group.pending === 0;
      });
    }
    async function readerProxy(drop: () => boolean) {
      let attempts = 0;
      const sockets = new Set<Socket>();
      const proxy = createTcpServer((socket) => {
        attempts++;
        sockets.add(socket);
        socket.on('close', () => sockets.delete(socket));
        if (drop()) {
          socket.destroy();
          return;
        }
        const upstream = tcpConnect(6381, '127.0.0.1');
        sockets.add(upstream);
        upstream.on('close', () => sockets.delete(upstream));
        socket.on('error', () => upstream.destroy());
        upstream.on('error', () => socket.destroy());
        socket.pipe(upstream).pipe(socket);
      });
      await new Promise<void>((resolve) =>
        proxy.listen(0, '127.0.0.1', resolve),
      );
      proxies.push(async () => {
        for (const socket of sockets) socket.destroy();
        await new Promise<void>((resolve) => proxy.close(() => resolve()));
      });
      const duplicate = index.redis.duplicate.bind(index.redis);
      vi.spyOn(index.redis, 'duplicate').mockImplementation((options) =>
        duplicate({
          ...options,
          url: `redis://127.0.0.1:${(proxy.address() as { port: number }).port}/9`,
        }),
      );
      return () => attempts;
    }
    beforeAll(async () => {
      await control.connect();
      if (await control.dbSize())
        throw new Error(
          'Disposable local Redis DB9 must be empty; existing data preserved',
        );
      await admin.connect();
      const schema = readFileSync(
        new URL('../schema.cql', import.meta.url),
        'utf8',
      ).replaceAll('wgo_map', keyspace);
      for (const sql of schema.split(';').filter((part) => part.trim()))
        await admin.execute(sql);
    }, 30000);
    beforeEach(async () => {
      vi.stubEnv('REDIS_URL', redisUrl);
      vi.stubEnv('CASSANDRA_MODE', 'local');
      vi.stubEnv('CASSANDRA_HOST', '127.0.0.1');
      vi.stubEnv('CASSANDRA_KEYSPACE', keyspace);
      vi.stubEnv(
        'MAP_SERVICE_TRUSTED_JWKS',
        JSON.stringify({
          keys: [
            {
              ...pair.publicKey.export({ format: 'jwk' }),
              kid: 'post-test',
              alg: 'ES256',
              iss: 'wgo-post-service',
            },
          ],
        }),
      );
      index = new PostIndex();
      await index.connect();
      await index.rebuild();
    });
    afterEach(async () => {
      for (const consumer of consumers.splice(0)) await consumer.stop();
      await Promise.allSettled(runs.splice(0));
      for (const close of proxies.splice(0)) await close();
      client?.close();
      client = undefined;
      server?.forceShutdown();
      server = undefined;
      await index?.close();
      await control.flushDb();
      for (const table of ['post_locations', 'post_status', 'posts_by_cell'])
        await admin.execute(`TRUNCATE ${keyspace}.${table}`);
      vi.restoreAllMocks();
      vi.unstubAllEnvs();
    });
    afterAll(async () => {
      await control.quit();
      await admin.execute(`DROP KEYSPACE ${keyspace}`);
      await admin.shutdown();
    });
    it('serves actual SearchNearbyPosts within the unchanged 500ms deadline while XREADGROUP is blocked', async () => {
      const store = {
        get: async () => null,
        movement: async () => null,
        put: async (_id: number, value: any) => value,
      };
      server = createGrpcServer(store, index);
      const address = await new Promise<number>((resolve, reject) =>
        server!.bindAsync(
          '127.0.0.1:0',
          ServerCredentials.createInsecure(),
          (error, port) => (error ? reject(error) : resolve(port)),
        ),
      );
      const pkg = loadPackageDefinition(
        loadSync('contracts/map-authorization.proto', { longs: String }),
      ) as any;
      client = new pkg.wgo.map.v1.MapPostQuery(
        `127.0.0.1:${address}`,
        credentials.createInsecure(),
      );
      startConsumer();
      const reader = await blocked();
      const now = Math.floor(Date.now() / 1000);
      const header = Buffer.from(
        JSON.stringify({
          alg: 'ES256',
          typ: 'wgo-service+jwt',
          kid: 'post-test',
        }),
      ).toString('base64url');
      const claims = Buffer.from(
        JSON.stringify({
          iss: 'wgo-post-service',
          sub: 'post-service',
          aud: 'wgo-map-service',
          iat: now,
          exp: now + 30,
        }),
      ).toString('base64url');
      const signature = sign('sha256', Buffer.from(`${header}.${claims}`), {
        key: pair.privateKey,
        dsaEncoding: 'ieee-p1363',
      }).toString('base64url');
      const metadata = new Metadata();
      metadata.set('authorization', `Bearer ${header}.${claims}.${signature}`);
      const started = performance.now();
      const response = await new Promise<any>((resolve, reject) =>
        client.searchNearbyPosts(
          { latitude: 37.5, longitude: 127, radiusM: 150, limit: 20 },
          metadata,
          { deadline: Date.now() + 500 },
          (error: unknown, value: unknown) =>
            error ? reject(error) : resolve(value),
        ),
      );
      expect(response.items ?? []).toEqual([]);
      expect(performance.now() - started).toBeLessThan(500);
      expect(await index.redis.ping()).toBe('PONG');
      expect(
        (await connections()).find((c) => c.id === reader.id)?.flags,
      ).toContain('b');
      expect(reader.id).not.toBe(String(await index.redis.clientId()));
    });
    it.each(['PostExpired', 'PostDeleted', 'PostHidden'] as const)(
      'preserves PostCreated and %s processing and ACKs',
      async (type) => {
        startConsumer();
        await blocked();
        const event = created(),
          id = await publish(event);
        await acknowledged(id);
        expect(await index.getStatus(event.aggregateId)).toBe('ACTIVE');
        const at = new Date().toISOString();
        const terminalId = await publish({
          eventId: `evt_${randomUUID()}`,
          eventType: type,
          schemaVersion: 1,
          producer: 'post-service',
          aggregateId: event.aggregateId,
          occurredAt: at,
          post: {
            postId: event.aggregateId,
            authorId: 123,
            category: 'INCIDENT',
            [type === 'PostExpired'
              ? 'expiredAt'
              : type === 'PostHidden'
                ? 'hiddenAt'
                : 'deletedAt']: at,
          },
        });
        await acknowledged(terminalId);
        expect(await index.getStatus(event.aggregateId)).toBe(
          type === 'PostExpired' ? 'EXPIRED' : 'DELETED',
        );
        const active = await control.get('map:posts:geo:active');
        expect(await control.geoPos(active!, event.aggregateId)).toEqual([
          null,
        ]);
        expect(await control.xLen(DEAD_STREAM)).toBe(0);
      },
      15000,
    );
    it('recovers another consumer pending delivery after restart with the same group and claim policy', async () => {
      await new PostConsumer(index).initialize();
      const event = created(),
        id = await publish(event);
      await control.xReadGroup(
        POST_GROUP,
        'crashed-consumer',
        { key: POST_STREAM, id: '>' },
        { COUNT: 1 },
      );
      expect((await control.xPending(POST_STREAM, POST_GROUP)).pending).toBe(1);
      await new Promise((resolve) => setTimeout(resolve, 1050));
      startConsumer();
      await acknowledged(id);
      expect(await index.getStatus(event.aggregateId)).toBe('ACTIVE');
    }, 15000);
    it('reconnects a killed reader and recovers a failed delivery from Pending', async () => {
      const write = vi
        .spyOn(index, 'write')
        .mockRejectedValueOnce(new Error('Transient write outage'));
      startConsumer();
      await blocked();
      const event = created(),
        id = await publish(event);
      await until(
        async () =>
          (await control.xPending(POST_STREAM, POST_GROUP)).pending === 1 &&
          write.mock.calls.length === 1,
      );
      const before = await blocked();
      expect(
        await control.sendCommand(['CLIENT', 'KILL', 'ID', before.id]),
      ).toBe(1);
      expect(await index.redis.ping()).toBe('PONG');
      await acknowledged(id);
      expect(write).toHaveBeenCalledTimes(2);
      expect(await index.getStatus(event.aggregateId)).toBe('ACTIVE');
      const after = await blocked();
      expect(after.id).not.toBe(before.id);
    }, 15000);
    it('retries initial reader connection errors without blocking the data connection', async () => {
      const attempts = await readerProxy(() => attempts() === 1);
      startConsumer();
      await blocked();
      expect(attempts()).toBeGreaterThanOrEqual(2);
      const event = created(),
        id = await publish(event);
      await acknowledged(id);
      expect(await index.getStatus(event.aggregateId)).toBe('ACTIVE');
      expect(await index.redis.ping()).toBe('PONG');
    }, 15000);
    it('cancels an initial connection/reconnect attempt on stop', async () => {
      const attempts = await readerProxy(() => true);
      const consumer = startConsumer();
      await until(async () => attempts() > 0);
      await consumer.stop();
      expect(
        (await connections()).some((c) => c.name.endsWith('-reader')),
      ).toBe(false);
      expect(await index.redis.ping()).toBe('PONG');
    }, 15000);
    it('drains in-flight processing and ACKs before stop resolves, without leaking the reader', async () => {
      let release!: () => void,
        entered = false;
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      const original = index.write.bind(index);
      vi.spyOn(index, 'write').mockImplementation(async (value) => {
        entered = true;
        await gate;
        return original(value);
      });
      const consumer = startConsumer(),
        reader = await blocked();
      const event = created(),
        id = await publish(event);
      await until(async () => entered);
      let stopped = false;
      const stopping = consumer.stop().then(() => {
        stopped = true;
      });
      try {
        await new Promise((resolve) => setTimeout(resolve, 30));
        expect(stopped).toBe(false);
      } finally {
        release();
      }
      await stopping;
      await acknowledged(id);
      await consumer.stop();
      expect(
        (await connections()).find((c) => c.id === reader.id),
      ).toBeUndefined();
      expect(index.redis.isReady).toBe(true);
    }, 15000);
    it('retains malformed-event DLQ-before-ACK behavior through the running consumer', async () => {
      startConsumer();
      await blocked();
      const id = await control.xAdd(POST_STREAM, '*', {
        eventId: `evt_${randomUUID()}`,
        eventType: 'PostCreated',
        data: '{}',
      });
      await acknowledged(id);
      const dead = await control.xRange(DEAD_STREAM, '-', '+');
      expect(dead).toHaveLength(1);
      expect(dead[0].message.streamId).toBe(id);
    }, 15000);
    it('stops a blocked reader promptly and never creates a reader after stop', async () => {
      const consumer = startConsumer(),
        reader = await blocked();
      expect(consumer.run()).toBe(runs[0]);
      const start = performance.now();
      await consumer.stop();
      expect(performance.now() - start).toBeLessThan(500);
      expect(
        (await connections()).find((c) => c.id === reader.id),
      ).toBeUndefined();
      const stopped = new PostConsumer(index);
      await stopped.stop();
      await stopped.run();
      expect(
        (await connections()).some((c) => c.name.endsWith('-reader')),
      ).toBe(false);
    });
  },
);
