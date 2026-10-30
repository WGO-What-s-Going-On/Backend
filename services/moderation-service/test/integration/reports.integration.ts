import { ConfigService } from '@nestjs/config';
import { NotFoundException } from '@nestjs/common';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { createClient } from 'redis';
import { Test } from '@nestjs/testing';
import { SignJWT } from 'jose';
import request from 'supertest';
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
import { ReportStore } from '../../src/reports/report.store.js';
import { ReportsService } from '../../src/reports/reports.service.js';
import { ReportTarget } from '../../src/reports/report-target.js';
import { ReportOutboxWorker } from '../../src/reports/report-outbox.worker.js';
import { ReportsController } from '../../src/reports/reports.controller.js';
import { GatewayAuthGuard } from '../../src/reports/gateway-auth.guard.js';
import { configureSwagger } from '../../src/swagger.js';

const redisUrl =
  process.env.MODERATION_TEST_REDIS_URL ?? 'redis://127.0.0.1:6383/13';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(redisUrl).hostname))
  throw new Error('Report integration tests require a dedicated local Redis');
const postId = 'post_123e4567-e89b-42d3-a456-426614174000';
const commentId = 'comment_123e4567-e89b-42d3-a456-426614174000';
const input = {
  targetType: 'POST',
  postId,
  reason: 'SPAM',
  description: 'Private description',
};
const config = new ConfigService({ redis: { url: redisUrl } });
const target = { verify: vi.fn(async () => {}) };
const command = promisify(execFile);

describe('Redis-only reports, Lua publication and durable recovery', () => {
  const redis = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false },
  });
  let connection: ReturnType<typeof createClient>;
  let store: ReportStore;
  let otherStore: ReportStore;
  let service: ReportsService;
  let otherService: ReportsService;
  let worker: ReportOutboxWorker;
  let other: ReportOutboxWorker;
  let authorized = false;
  let owned: string[];
  beforeAll(async () => {
    redis.on('error', () => undefined);
    await redis.connect();
    if (await redis.dbSize())
      throw new Error(
        'Report test Redis DB must be empty; existing data preserved',
      );
    authorized = true;
  });
  beforeEach(() => {
    target.verify.mockReset().mockResolvedValue();
    connection = createClient({
      url: redisUrl,
      socket: { reconnectStrategy: false },
    });
    store = new ReportStore(config, connection);
    otherStore = new ReportStore(config);
    service = new ReportsService(store, target as unknown as ReportTarget);
    otherService = new ReportsService(
      otherStore,
      target as unknown as ReportTarget,
    );
    worker = new ReportOutboxWorker(store);
    other = new ReportOutboxWorker(otherStore);
    owned = [store.recordsKey, store.pendingKey, store.stream];
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    await Promise.all([worker?.onModuleDestroy(), other?.onModuleDestroy()]);
    await Promise.all([
      store?.onModuleDestroy(),
      otherStore?.onModuleDestroy(),
    ]);
    if (authorized) {
      if (!redis.isOpen) await redis.connect();
      // Only keys created by this isolated suite; never FLUSHDB/FLUSHALL.
      await redis.del(owned);
    }
  });
  afterAll(async () => {
    if (redis.isOpen) await redis.quit();
  });
  async function records() {
    return Object.entries(await redis.hGetAll(store.recordsKey))
      .filter(([field]) => field.startsWith('target:'))
      .map(([field, value]) => ({ field, ...JSON.parse(value) }));
  }
  async function events() {
    return (await redis.xRange(store.stream, '-', '+')).map(({ message }) => {
      const envelope = JSON.parse(message.data!);
      expect(envelope.eventId).toBe(message.eventId);
      expect(envelope.eventType).toBe(message.eventType);
      expect(envelope).toMatchObject({
        schemaVersion: 1,
        producer: 'moderation-service',
      });
      expect(envelope.eventId).toMatch(/^[0-9a-f-]{36}$/);
      expect(envelope).not.toHaveProperty('data.description');
      return envelope;
    });
  }
  function fault(point: string, action = 'create') {
    const evaluate = connection.eval.bind(connection);
    return vi
      .spyOn(connection, 'eval')
      .mockImplementation((script, options) =>
        evaluate(
          options?.arguments?.[0] === action
            ? String(script).replaceAll(
                `-- fault:${point}`,
                `error('injected ${point}')`,
              )
            : script,
          options,
        ),
      );
  }
  it('publishes post/comment creation immediately with the original wire contract and immutable retries', async () => {
    const first = await service.create('100', input);
    expect(first).toMatchObject({ status: 'PENDING', withdrawnAt: null });
    expect(
      await service.create('100', {
        ...input,
        reason: 'OTHER',
        description: 'Changed',
      }),
    ).toEqual(first);
    await service.create('100', { ...input, targetType: 'COMMENT', commentId });
    expect(target.verify).toHaveBeenCalledTimes(2);
    expect(await records()).toHaveLength(2);
    const messages = await events();
    expect(messages).toHaveLength(2);
    expect(messages[0]).toEqual({
      eventId: expect.any(String),
      eventType: 'REPORT_CREATED',
      schemaVersion: 1,
      producer: 'moderation-service',
      occurredAt: first.createdAt,
      data: {
        reportId: first.reportId,
        reporterUserId: '100',
        targetType: 'POST',
        postId,
        reason: 'SPAM',
      },
    });
    expect(messages[1].data).toMatchObject({
      targetType: 'COMMENT',
      commentId,
    });
    expect(await redis.sCard(store.pendingKey)).toBe(0);
    expect(await redis.ttl(store.recordsKey)).toBe(-1);
  });
  it('serializes cross-instance concurrent create/withdraw retries and preserves ownership and order', async () => {
    const created = await Promise.all(
      Array.from({ length: 24 }, (_, i) =>
        (i % 2 ? service : otherService).create('100', input),
      ),
    );
    expect(new Set(created.map((r) => r.reportId)).size).toBe(1);
    const first = created[0]!;
    await expect(service.withdraw('200', first.reportId)).rejects.toMatchObject(
      { status: 404 },
    );
    const mixed = await Promise.allSettled(
      Array.from({ length: 36 }, (_, i) =>
        i % 3 === 0
          ? service.create('100', input)
          : (i % 2 ? service : otherService).withdraw('100', first.reportId),
      ),
    );
    for (const result of mixed)
      if (result.status === 'rejected') expect(result.reason.status).toBe(409);
    const withdrawn = await service.withdraw('100', first.reportId);
    expect(withdrawn.status).toBe('WITHDRAWN');
    expect(await otherService.withdraw('100', first.reportId)).toEqual(
      withdrawn,
    );
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 409,
    });
    expect((await records())[0].report).toMatchObject({
      description: input.description,
      createdAt: first.createdAt,
      withdrawnAt: withdrawn.withdrawnAt,
    });
    await Promise.all([worker.publishPending(), other.publishPending()]);
    const messages = await events();
    expect(messages.map((e) => e.eventType)).toEqual([
      'REPORT_CREATED',
      'REPORT_WITHDRAWN',
    ]);
    expect(messages[1].data).toEqual({
      reportId: first.reportId,
      reporterUserId: '100',
      targetType: 'POST',
      postId,
      withdrawnAt: withdrawn.withdrawnAt,
    });
    expect(messages[1].occurredAt).toBe(withdrawn.withdrawnAt);
  });
  it('rejects reviewed withdrawal and missing targets without extra events', async () => {
    const first = await service.create('100', input);
    const record = (await records())[0];
    record.report.status = 'REVIEWED';
    await redis.hSet(store.recordsKey, record.field, JSON.stringify(record));
    await expect(service.withdraw('100', first.reportId)).rejects.toMatchObject(
      { status: 409 },
    );
    target.verify.mockRejectedValueOnce(new NotFoundException());
    await expect(service.create('200', input)).rejects.toMatchObject({
      status: 404,
    });
    expect(await events()).toHaveLength(1);
  });
  it.each(['recordsKey', 'pendingKey', 'stream'] as const)(
    'validates %s type before changing state or publishing',
    async (key) => {
      await redis.set(store[key], 'existing wrong type');
      await expect(service.create('100', input)).rejects.toMatchObject({
        status: 503,
      });
      expect(await redis.get(store[key])).toBe('existing wrong type');
      for (const candidate of [
        store.recordsKey,
        store.pendingKey,
        store.stream,
      ])
        if (candidate !== store[key])
          expect(await redis.exists(candidate)).toBe(0);
    },
  );
  it('handles Lua failure before the canonical HSET without creating a report or event', async () => {
    const injected = fault('before-state');
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 503,
    });
    expect(await records()).toEqual([]);
    expect(await redis.xLen(store.stream)).toBe(0);
    expect(await redis.sCard(store.pendingKey)).toBe(1);
    injected.mockRestore();
    await other.publishPending();
    expect(await redis.sCard(store.pendingKey)).toBe(0);
    await service.create('100', input);
    expect(await events()).toHaveLength(1);
  });
  it('automatically recovers state committed before XADD without a client retry', async () => {
    const injected = fault('after-state');
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 503,
    });
    const original = (await records())[0];
    expect(original.events[0].streamId).toBeUndefined();
    expect(await redis.xLen(store.stream)).toBe(0);
    injected.mockRestore();
    other.onApplicationBootstrap();
    await expect.poll(() => redis.xLen(store.stream)).toBe(1);
    expect((await events())[0].eventId).toBe(
      original.events[0].envelope.eventId,
    );
    expect((await service.create('100', input)).reportId).toBe(
      original.report.reportId,
    );
    expect(await redis.sCard(store.pendingKey)).toBe(0);
  });
  it('retains pending state when XADD errors and recovers after the operator repairs the stream', async () => {
    const injected = fault('after-state');
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 503,
    });
    injected.mockRestore();
    const original = (await records())[0];
    await redis.set(store.stream, 'wrong type');
    await other.publishPending();
    expect(await redis.sCard(store.pendingKey)).toBe(1);
    await expect(
      service.withdraw('100', original.report.reportId),
    ).rejects.toMatchObject({ status: 503 });
    expect((await records())[0].report.status).toBe('PENDING');
    // Repair only this test-owned key; production never deletes a broken stream.
    await redis.del(store.stream);
    await other.publishPending();
    await service.withdraw('100', original.report.reportId);
    expect((await events()).map((e) => e.eventType)).toEqual([
      'REPORT_CREATED',
      'REPORT_WITHDRAWN',
    ]);
    expect((await events())[0].eventId).toBe(
      original.events[0].envelope.eventId,
    );
  });
  it.each(['create', 'withdraw'])(
    'replays the same eventId after XADD receipt failure for %s without reversing order',
    async (action) => {
      const first =
        action === 'withdraw' ? await service.create('100', input) : undefined;
      const injected = fault('after-xadd', action);
      await expect(
        first
          ? service.withdraw('100', first.reportId)
          : service.create('100', input),
      ).rejects.toMatchObject({ status: 503 });
      const canonical = (await records())[0];
      injected.mockRestore();
      if (!first) await otherService.withdraw('100', canonical.report.reportId);
      await Promise.all([worker.publishPending(), other.publishPending()]);
      await worker.publishPending();
      const messages = await events();
      expect(messages.map((e) => e.eventType)).toEqual(
        first
          ? ['REPORT_CREATED', 'REPORT_WITHDRAWN', 'REPORT_WITHDRAWN']
          : ['REPORT_CREATED', 'REPORT_CREATED', 'REPORT_WITHDRAWN'],
      );
      const duplicates = messages.filter(
        (e) => e.eventType === (first ? 'REPORT_WITHDRAWN' : 'REPORT_CREATED'),
      );
      expect(duplicates[0]).toEqual(duplicates[1]);
      expect(new Set(messages.map((e) => e.eventId)).size).toBe(2);
      expect(await redis.sCard(store.pendingKey)).toBe(0);
    },
  );
  it('does not duplicate a fully committed event when only the response is lost', async () => {
    const evaluate = connection.eval.bind(connection);
    const injected = vi
      .spyOn(connection, 'eval')
      .mockImplementation(async (script, options) => {
        const result = await evaluate(script, options);
        if (options?.arguments?.[0] === 'create')
          throw new Error('response lost after execution');
        return result;
      });
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 503,
    });
    injected.mockRestore();
    const canonical = (await records())[0].report;
    expect((await service.create('100', input)).reportId).toBe(
      canonical.reportId,
    );
    await Promise.all([worker.publishPending(), other.publishPending()]);
    expect(await events()).toHaveLength(1);
  });
  it('retains the old state if withdrawal fails before its canonical write', async () => {
    const first = await service.create('100', input);
    const injected = fault('before-state', 'withdraw');
    await expect(service.withdraw('100', first.reportId)).rejects.toMatchObject(
      { status: 503 },
    );
    expect((await records())[0].report.status).toBe('PENDING');
    injected.mockRestore();
    await other.publishPending();
    expect(await redis.sCard(store.pendingKey)).toBe(0);
    await service.withdraw('100', first.reportId);
    expect((await events()).map((e) => e.eventType)).toEqual([
      'REPORT_CREATED',
      'REPORT_WITHDRAWN',
    ]);
  });
  it('does not republish an acknowledged event when pending queue cleanup fails', async () => {
    const injected = fault('after-receipt');
    await expect(service.create('100', input)).rejects.toMatchObject({
      status: 503,
    });
    expect(await redis.sCard(store.pendingKey)).toBe(1);
    expect((await records())[0].events[0].streamId).toBeDefined();
    injected.mockRestore();
    await Promise.all([worker.publishPending(), other.publishPending()]);
    expect(await redis.sCard(store.pendingKey)).toBe(0);
    expect(await events()).toHaveLength(1);
  });
  it('drains a bounded recovery batch across instances without skipping SSCAN overflow', async () => {
    const injected = fault('after-state');
    for (let i = 0; i < 45; i++)
      await expect(
        service.create(String(1000 + i), input),
      ).rejects.toMatchObject({ status: 503 });
    injected.mockRestore();
    expect(await redis.sCard(store.pendingKey)).toBe(45);
    for (let i = 0; i < 20 && (await redis.sCard(store.pendingKey)); i++)
      await Promise.all([worker.publishPending(), other.publishPending()]);
    expect(await redis.sCard(store.pendingKey)).toBe(0);
    expect(await events()).toHaveLength(45);
    expect(new Set((await events()).map((e) => e.eventId)).size).toBe(45);
  });
  it('keeps legacy reports, unrelated streams and consumer pending entries unchanged', async () => {
    const legacy = `moderation:report:${randomUUID()}`;
    const keys = [
      legacy,
      'moderation:events',
      'moderation:content-events',
      'post:events',
    ];
    owned.push(...keys);
    await redis.set(legacy, 'legacy report with its original id');
    for (const key of keys.slice(1))
      await redis.xAdd(key, '*', {
        eventId: 'existing',
        eventType: 'existing',
        data: 'original payload',
      });
    await redis.xGroupCreate('post:events', 'existing-consumer', '0');
    await redis.xReadGroup('existing-consumer', 'existing-worker', {
      key: 'post:events',
      id: '>',
    });
    const before = await Promise.all(keys.map((key) => redis.dump(key)));
    const oldReportEntry = await redis.xAdd(store.stream, '*', {
      eventId: 'prior-report-event',
      eventType: 'REPORT_CREATED',
      data: 'prior wire payload',
    });
    await redis.xGroupCreate(store.stream, 'prior-report-consumer', '0');
    await redis.xReadGroup('prior-report-consumer', 'prior-report-worker', {
      key: store.stream,
      id: '>',
    });
    const priorReportMessages = await redis.xRange(store.stream, '-', '+');
    await service.create('100', input);
    await worker.publishPending();
    expect(await Promise.all(keys.map((key) => redis.dump(key)))).toEqual(
      before,
    );
    expect(
      (await redis.xPending('post:events', 'existing-consumer')).pending,
    ).toBe(1);
    expect((await redis.xRange(store.stream, '-', '+'))[0]).toEqual(
      priorReportMessages[0],
    );
    expect(
      (
        await redis.xPendingRange(
          store.stream,
          'prior-report-consumer',
          '-',
          '+',
          10,
        )
      )[0]?.id,
    ).toBe(oldReportEntry);
  });
  it('returns 503 without an in-memory fallback when Redis is unconfigured or unavailable', async () => {
    for (const redisConfig of [{}, { url: 'redis://127.0.0.1:1' }]) {
      const unavailable = new ReportStore(
        new ConfigService({ redis: redisConfig }),
      );
      try {
        await expect(
          new ReportsService(
            unavailable,
            target as unknown as ReportTarget,
          ).create('100', input),
        ).rejects.toMatchObject({ status: 503 });
      } finally {
        await unavailable.onModuleDestroy();
      }
    }
    expect(await records()).toEqual([]);
  });
  it('preserves actual authenticated HTTP, OpenAPI and create/withdraw responses with Redis storage', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'P-256',
    });
    vi.stubEnv(
      'MODERATION_HTTP_GATEWAY_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'reports-redis-test',
            alg: 'ES256',
            iss: 'wgo-http-gateway',
          },
        ],
      }),
    );
    const module = await Test.createTestingModule({
      controllers: [ReportsController],
      providers: [
        GatewayAuthGuard,
        { provide: ReportsService, useValue: service },
      ],
    }).compile();
    const app = module.createNestApplication();
    app.useLogger(false);
    configureSwagger(app);
    await app.listen(0, '127.0.0.1');
    try {
      const now = Math.floor(Date.now() / 1000);
      const bearer = `Bearer ${await new SignJWT({ userId: '100' })
        .setProtectedHeader({
          alg: 'ES256',
          kid: 'reports-redis-test',
          typ: 'wgo-service+jwt',
        })
        .setIssuer('wgo-http-gateway')
        .setSubject('http-gateway')
        .setAudience('wgo-moderation-service')
        .setIssuedAt(now)
        .setExpirationTime(now + 30)
        .sign(privateKey)}`;
      await request(app.getHttpServer())
        .post('/api/v1/moderation/reports')
        .send(input)
        .expect(401);
      const created = await request(app.getHttpServer())
        .post('/api/v1/moderation/reports')
        .set('Authorization', bearer)
        .set('X-User-Id', '100')
        .send(input)
        .expect(201);
      expect(created.body).toEqual({
        reportId: expect.stringMatching(/^report_/),
        status: 'PENDING',
        createdAt: expect.any(String),
        withdrawnAt: null,
      });
      const withdrawn = await request(app.getHttpServer())
        .delete(`/api/v1/moderation/reports/${created.body.reportId}`)
        .set('Authorization', bearer)
        .set('X-User-Id', '100')
        .expect(200);
      expect(withdrawn.body).toMatchObject({
        reportId: created.body.reportId,
        status: 'WITHDRAWN',
      });
      const { body: doc } = await request(app.getHttpServer())
        .get('/docs/openapi.json')
        .expect(200);
      expect(
        doc.paths['/api/v1/moderation/reports'].post.responses['201'],
      ).toBeDefined();
      expect(
        doc.paths['/api/v1/moderation/reports/{reportId}'].delete.responses[
          '200'
        ],
      ).toBeDefined();
      expect((await events()).map((e) => e.eventType)).toEqual([
        'REPORT_CREATED',
        'REPORT_WITHDRAWN',
      ]);
    } finally {
      await app.close();
    }
  });
  it.skipIf(!process.env.MODERATION_REPORT_RESTART_CONTAINER)(
    'recovers committed state, event IDs, order and pending publication after an abrupt AOF Redis restart',
    async () => {
      const container = process.env.MODERATION_REPORT_RESTART_CONTAINER!;
      const inspect = JSON.parse(
        (await command('docker', ['inspect', container], { windowsHide: true }))
          .stdout,
      )[0];
      expect(inspect.Config.Labels['com.wgo.moderation-report-test']).toBe('1');
      expect(container).toMatch(/^wgo-report-redis-test-/);
      const server = (await redis.info('server'))
        .match(/run_id:(.+)/)?.[1]
        ?.trim();
      const inside = (
        await command(
          'docker',
          ['exec', container, 'redis-cli', 'INFO', 'server'],
          { windowsHide: true },
        )
      ).stdout;
      expect(inside).toContain(`run_id:${server}`);
      expect(await redis.configGet('appendonly')).toEqual({
        appendonly: 'yes',
      });
      expect(await redis.configGet('appendfsync')).toEqual({
        appendfsync: 'always',
      });
      const first = await service.create('100', input);
      const injected = fault('after-state', 'withdraw');
      await expect(
        service.withdraw('100', first.reportId),
      ).rejects.toMatchObject({ status: 503 });
      injected.mockRestore();
      const before = await redis.hGetAll(store.recordsKey);
      const journal = (await records())[0].events;
      await command('docker', ['kill', '--signal', 'KILL', container], {
        windowsHide: true,
      });
      await expect.poll(() => redis.isOpen).toBe(false);
      await command('docker', ['start', container], { windowsHide: true });
      for (let attempt = 0; ; attempt++) {
        try {
          await redis.connect();
          break;
        } catch (error) {
          if (attempt >= 30) throw error;
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      expect(await redis.hGetAll(store.recordsKey)).toEqual(before);
      expect(await redis.xLen(store.stream)).toBe(1);
      expect(await redis.sCard(store.pendingKey)).toBe(1);
      await other.publishPending();
      const messages = await events();
      expect(messages.map((e) => e.eventType)).toEqual([
        'REPORT_CREATED',
        'REPORT_WITHDRAWN',
      ]);
      expect(messages.map((e) => e.eventId)).toEqual(
        journal.map(
          (entry: { envelope: { eventId: string } }) => entry.envelope.eventId,
        ),
      );
      expect((await otherService.withdraw('100', first.reportId)).status).toBe(
        'WITHDRAWN',
      );
      expect(await redis.sCard(store.pendingKey)).toBe(0);
    },
    30000,
  );
});
