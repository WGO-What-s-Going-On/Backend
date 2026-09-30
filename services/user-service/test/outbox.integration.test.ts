import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { connect, createServer, type Socket } from 'node:net';
import { DataSource } from 'typeorm';
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
import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { OutboxEventEntity } from '../src/database/entities/outbox-event.entity.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from '../src/database/migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import {
  RedisStreamsPublisher,
  USER_EVENTS_STREAM,
} from '../src/outbox/redis-streams.publisher.js';

const testDatabaseName = `wgo_outbox_test_${process.pid}_${Date.now()}`;
// Auth tests use DB 15. Only this stream in dedicated DB 14 is touched here.
const redisUrl = 'redis://127.0.0.1:6379/14';

describe('User Outbox PostgreSQL / Redis integration', () => {
  let admin: DataSource;
  let database: DataSource;
  let redis: Redis;
  let app: INestApplication | undefined;
  const workers: OutboxWorker[] = [];

  beforeAll(async () => {
    const db = configuration().database;
    const options = {
      type: 'postgres' as const,
      host: db.host,
      port: db.port,
      username: db.username,
      password: db.password,
    };
    admin = new DataSource({ ...options, database: 'postgres' });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${testDatabaseName}"`);
    database = new DataSource({
      ...options,
      database: testDatabaseName,
      entities: [...USER_SERVICE_ENTITIES],
      synchronize: false,
      migrations: [
        InitialUserServiceSchema1789990707351,
        AddTermsCodeEffectiveAtIndex1789993249262,
      ],
    });
    await database.initialize();
    await database.runMigrations();
    redis = new Redis(redisUrl);
    await redis.ping();
  }, 30_000);

  beforeEach(async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await database.query('TRUNCATE TABLE outbox_events');
    await redis.del(USER_EVENTS_STREAM);
  });

  afterEach(async () => {
    if (app) {
      await app.close();
      app = undefined;
    }
    await Promise.all(
      workers.splice(0).map((worker) => worker.onModuleDestroy()),
    );
    vi.restoreAllMocks();
  });

  afterAll(async () => {
    if (redis) {
      await redis.del(USER_EVENTS_STREAM);
      await redis.quit();
    }
    if (database?.isInitialized) await database.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${testDatabaseName}" WITH (FORCE)`);
      await admin.destroy();
    }
  }, 30_000);

  it.each([
    'USER_CREATED',
    'USER_PROFILE_UPDATED',
    'USER_WITHDRAWAL_STARTED',
    'USER_RESTORED',
    'USER_WITHDRAWN',
  ])('publishes %s without changing any envelope fields', async (type) => {
    const event = await seed(type);
    const { worker } = makeWorker();
    await worker.publishPending();
    const entries = await messages();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toEqual({
      eventId: event.eventId,
      eventType: type,
      data: JSON.stringify(event.payload),
    });
    expect(JSON.parse(entries[0]!.data!)).toEqual(event.payload);
    const stored = await row(event.eventId);
    expect(stored).toEqual({
      ...event,
      status: 'PUBLISHED',
      publishAttempts: 1,
      publishedAt: expect.any(Date),
    });
    expect(stored.publishedAt!.getTime()).toBeGreaterThanOrEqual(
      event.createdAt.getTime(),
    );
    await worker.publishPending();
    expect(await messages()).toEqual(entries);
    expect(await row(event.eventId)).toEqual(stored);
  });

  it('orders each batch by created_at then event_id and respects the batch limit', async () => {
    const now = new Date();
    const ids = [
      '00000000-0000-4000-8000-000000000003',
      '00000000-0000-4000-8000-000000000002',
      '00000000-0000-4000-8000-000000000001',
    ];
    await seed('USER_CREATED', ids[0], new Date(now.getTime() + 1000));
    await seed('USER_CREATED', ids[1], now);
    await seed('USER_CREATED', ids[2], now);
    const { worker } = makeWorker(2);
    await worker.publishPending();
    expect((await messages()).map((entry) => entry.eventId)).toEqual([
      ids[2],
      ids[1],
    ]);
    expect((await row(ids[0]!)).status).toBe('PENDING');
    await worker.publishPending();
    expect((await messages()).map((entry) => entry.eventId)).toEqual([
      ids[2],
      ids[1],
      ids[0],
    ]);
  });

  it('counts failed XADD attempts, leaves rows pending, then retries after Redis recovers', async () => {
    const event = await seed();
    const { worker } = makeWorker();
    // A real Redis WRONGTYPE error, not a mocked publisher rejection.
    await redis.set(USER_EVENTS_STREAM, 'test-unavailable-stream');
    await worker.publishPending();
    expect(await row(event.eventId)).toEqual({ ...event, publishAttempts: 1 });
    await worker.publishPending();
    expect((await row(event.eventId)).publishAttempts).toBe(2);
    await redis.del(USER_EVENTS_STREAM);
    await worker.publishPending();
    expect(await row(event.eventId)).toMatchObject({
      status: 'PUBLISHED',
      publishAttempts: 3,
    });
    expect((await messages()).map((entry) => entry.eventId)).toEqual([
      event.eventId,
    ]);
  });

  it('reconnects after a network outage without counting connections as XADD attempts', async () => {
    // This local proxy disrupts only this publisher connection, never the shared Redis server.
    let online = false;
    const sockets = new Set<Socket>();
    const proxy = createServer((client) => {
      if (!online) {
        client.destroy();
        return;
      }
      const upstream = connect(6379, '127.0.0.1');
      for (const socket of [client, upstream]) {
        sockets.add(socket);
        socket.on('error', () => {
          client.destroy();
          upstream.destroy();
        });
        socket.on('close', () => {
          sockets.delete(socket);
          client.destroy();
          upstream.destroy();
        });
      }
      client.pipe(upstream).pipe(client);
    });
    proxy.listen(0, '127.0.0.1');
    await once(proxy, 'listening');
    const address = proxy.address() as { port: number };
    const { worker } = makeWorker(
      2,
      1000,
      `redis://127.0.0.1:${address.port}/14`,
    );
    try {
      const event = await seed();
      await worker.publishPending();
      expect(await row(event.eventId)).toEqual(event);
      online = true;
      await worker.publishPending();
      expect(await row(event.eventId)).toMatchObject({
        status: 'PUBLISHED',
        publishAttempts: 1,
      });
      expect(await messages()).toHaveLength(1);
    } finally {
      await worker.onModuleDestroy();
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve) => proxy.close(() => resolve()));
    }
  });

  it('commits earlier successes and the failed attempt but leaves the rest of the batch untouched', async () => {
    const first = await seed(
      'USER_CREATED',
      undefined,
      new Date(Date.now() - 2000),
    );
    const second = await seed(
      'USER_PROFILE_UPDATED',
      undefined,
      new Date(Date.now() - 1000),
    );
    const third = await seed();
    const { worker, publisher } = makeWorker(3);
    const publish = publisher.publish.bind(publisher);
    vi.spyOn(publisher, 'publish')
      .mockImplementationOnce(publish)
      .mockRejectedValueOnce(new Error('Injected XADD failure'));
    await worker.publishPending();
    expect(await row(first.eventId)).toMatchObject({
      status: 'PUBLISHED',
      publishAttempts: 1,
    });
    expect(await row(second.eventId)).toEqual({
      ...second,
      publishAttempts: 1,
    });
    expect(await row(third.eventId)).toEqual(third);
    await worker.publishPending();
    expect((await messages()).map((entry) => entry.eventId)).toEqual([
      first.eventId,
      second.eventId,
      third.eventId,
    ]);
    expect((await row(second.eventId)).publishAttempts).toBe(2);
    expect((await row(third.eventId)).publishAttempts).toBe(1);
  });

  it('uses SKIP LOCKED so another worker processes unlocked rows without duplicate publishing', async () => {
    const first = await seed(
      'USER_CREATED',
      undefined,
      new Date(Date.now() - 1000),
    );
    const second = await seed();
    const a = makeWorker(1);
    const b = makeWorker(1);
    const started = deferred();
    const release = deferred();
    const publish = a.publisher.publish.bind(a.publisher);
    vi.spyOn(a.publisher, 'publish').mockImplementationOnce(
      async (envelope) => {
        started.resolve();
        await release.promise;
        await publish(envelope);
      },
    );
    const inFlight = a.worker.publishPending();
    await started.promise;
    try {
      await b.worker.publishPending();
      expect((await row(second.eventId)).status).toBe('PUBLISHED');
      expect((await row(first.eventId)).status).toBe('PENDING');
      expect((await messages()).map((entry) => entry.eventId)).toEqual([
        second.eventId,
      ]);
    } finally {
      release.resolve();
      await inFlight;
    }
    expect((await messages()).map((entry) => entry.eventId).sort()).toEqual(
      [first.eventId, second.eventId].sort(),
    );
    expect((await row(first.eventId)).publishAttempts).toBe(1);
    expect((await row(second.eventId)).publishAttempts).toBe(1);
  });

  it('rolls back after XADD when DB commit fails and republishes the SAME eventId', async () => {
    const event = await seed();
    const { worker } = makeWorker();
    await database.query(`CREATE FUNCTION test_reject_outbox_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected outbox commit failure'; END $$`);
    await database.query(`CREATE CONSTRAINT TRIGGER test_reject_outbox_commit
      AFTER UPDATE ON outbox_events DEFERRABLE INITIALLY DEFERRED
      FOR EACH ROW EXECUTE FUNCTION test_reject_outbox_commit()`);
    try {
      await worker.publishPending();
      expect(await messages()).toHaveLength(1);
      // Transactional attempt counters cannot survive the crash/rollback window either.
      expect(await row(event.eventId)).toEqual(event);
    } finally {
      await database.query(
        'DROP TRIGGER test_reject_outbox_commit ON outbox_events',
      );
      await database.query('DROP FUNCTION test_reject_outbox_commit()');
    }
    await worker.publishPending();
    const entries = await messages();
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual(entries[1]);
    expect(JSON.parse(entries[1]!.data!)).toEqual(event.payload);
    expect(await row(event.eventId)).toMatchObject({
      status: 'PUBLISHED',
      publishAttempts: 1,
    });
  });

  it('does not see uncommitted events or publish rolled-back domain events', async () => {
    const { worker } = makeWorker();
    const runner = database.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const event = fixture();
      await runner.manager.getRepository(OutboxEventEntity).save(event);
      await worker.publishPending();
      expect(await messages()).toHaveLength(0);
      await runner.rollbackTransaction();
      await worker.publishPending();
      expect(await messages()).toHaveLength(0);
    } finally {
      if (runner.isTransactionActive) await runner.rollbackTransaction();
      await runner.release();
    }
  });

  it('leaves mismatched envelope identity pending without inventing fields or attempts', async () => {
    const event = await seed();
    await database.getRepository(OutboxEventEntity).update(event.eventId, {
      payload: { ...event.payload, eventId: randomUUID() },
    });
    await makeWorker().worker.publishPending();
    expect(await messages()).toHaveLength(0);
    expect(await row(event.eventId)).toMatchObject({
      status: 'PENDING',
      publishAttempts: 0,
      publishedAt: null,
    });
  });

  it('polls after application bootstrap, survives a DB error, and stops on shutdown', async () => {
    const config = makeConfig(2, 30);
    const module = await Test.createTestingModule({
      providers: [
        OutboxWorker,
        RedisStreamsPublisher,
        { provide: ConfigService, useValue: config },
        { provide: getDataSourceToken(), useValue: database },
      ],
    }).compile();
    app = module.createNestApplication();
    vi.spyOn(database, 'transaction').mockRejectedValueOnce(
      new Error('Temporary DB failure'),
    );
    await app.init();
    const event = await seed();
    await vi.waitFor(
      async () => {
        expect((await row(event.eventId)).status).toBe('PUBLISHED');
      },
      { timeout: 2000 },
    );
    const worker = module.get(OutboxWorker);
    await app.close();
    app = undefined;
    const later = await seed();
    await worker.publishPending();
    expect(await row(later.eventId)).toEqual(later);
    expect(await messages()).toHaveLength(1);
  });

  it('coalesces overlapping runs and drains the current publish before closing', async () => {
    const event = await seed();
    const { worker, publisher } = makeWorker();
    const started = deferred();
    const release = deferred();
    const publish = publisher.publish.bind(publisher);
    vi.spyOn(publisher, 'publish').mockImplementationOnce(async (envelope) => {
      started.resolve();
      await release.promise;
      await publish(envelope);
    });
    const close = vi.spyOn(publisher, 'close');
    const first = worker.publishPending();
    await started.promise;
    expect(worker.publishPending()).toBe(first);
    const shutdown = worker.onModuleDestroy();
    try {
      expect(close).not.toHaveBeenCalled();
    } finally {
      release.resolve();
    }
    await Promise.all([first, shutdown]);
    expect(close).toHaveBeenCalledTimes(1);
    expect((await row(event.eventId)).status).toBe('PUBLISHED');
    expect(await messages()).toHaveLength(1);
  });

  function makeConfig(
    batchSize = 20,
    pollIntervalMs = 1000,
    url = redisUrl,
  ): ConfigService {
    return new ConfigService({
      redis: { url },
      outbox: { batchSize, pollIntervalMs, redisTimeoutMs: 300 },
    });
  }

  function makeWorker(batchSize = 20, pollIntervalMs = 1000, url = redisUrl) {
    const config = makeConfig(batchSize, pollIntervalMs, url);
    const publisher = new RedisStreamsPublisher(config);
    const worker = new OutboxWorker(database, publisher, config);
    workers.push(worker);
    return { worker, publisher };
  }

  function fixture(
    type = 'USER_PROFILE_UPDATED',
    id: string = randomUUID(),
    now = new Date(),
  ): OutboxEventEntity {
    const userId = '12345';
    const payload =
      type === 'USER_WITHDRAWAL_STARTED'
        ? {
            userId,
            recoverableUntil: new Date(
              now.getTime() + 30 * 86400000,
            ).toISOString(),
          }
        : type === 'USER_RESTORED'
          ? { userId, status: 'ACTIVE' }
          : type === 'USER_WITHDRAWN'
            ? { userId, withdrawnAt: now.toISOString() }
            : { userId, nickname: '테스트', profileImageKey: null };
    return database.getRepository(OutboxEventEntity).create({
      eventId: id,
      eventType: type,
      aggregateId: userId,
      status: 'PENDING',
      publishAttempts: 0,
      createdAt: now,
      publishedAt: null,
      payload: {
        eventId: id,
        type,
        producer: 'user-service',
        correlationId: randomUUID(),
        target: { type: 'USER', id: userId },
        occurredAt: now.toISOString(),
        version: 1,
        payload,
      },
    });
  }

  async function seed(
    type?: string,
    id?: string,
    now?: Date,
  ): Promise<OutboxEventEntity> {
    const event = fixture(type, id, now);
    await database.getRepository(OutboxEventEntity).save(event);
    return row(event.eventId);
  }

  function row(eventId: string): Promise<OutboxEventEntity> {
    return database
      .getRepository(OutboxEventEntity)
      .findOneByOrFail({ eventId });
  }

  async function messages(): Promise<Record<string, string>[]> {
    return (await redis.xrange(USER_EVENTS_STREAM, '-', '+')).map(
      ([, fields]) => {
        const message: Record<string, string> = {};
        for (let i = 0; i < fields.length; i += 2)
          message[fields[i]!] = fields[i + 1]!;
        return message;
      },
    );
  }

  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
});

describe('Outbox configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('provides defaults and accepts environment overrides', () => {
    for (const key of [
      'OUTBOX_POLL_INTERVAL_MS',
      'OUTBOX_BATCH_SIZE',
      'OUTBOX_REDIS_TIMEOUT_MS',
    ]) {
      vi.stubEnv(key, undefined);
    }
    expect(configuration().outbox).toEqual({
      pollIntervalMs: 1000,
      batchSize: 20,
      redisTimeoutMs: 2000,
    });
    vi.stubEnv('OUTBOX_POLL_INTERVAL_MS', '50');
    vi.stubEnv('OUTBOX_BATCH_SIZE', '3');
    vi.stubEnv('OUTBOX_REDIS_TIMEOUT_MS', '100');
    expect(configuration().outbox).toEqual({
      pollIntervalMs: 50,
      batchSize: 3,
      redisTimeoutMs: 100,
    });
  });

  it.each([
    'OUTBOX_POLL_INTERVAL_MS',
    'OUTBOX_BATCH_SIZE',
    'OUTBOX_REDIS_TIMEOUT_MS',
  ])('rejects invalid %s', (key) => {
    for (const value of ['0', '-1', '1.5', 'invalid']) {
      vi.stubEnv(key, value);
      expect(() => configuration()).toThrow(
        `${key} must be a positive integer`,
      );
    }
  });
});
