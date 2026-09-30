import { Logger, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
import {
  Client,
  credentials,
  loadPackageDefinition,
  Metadata,
  status,
  type ServiceError,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import { Redis } from 'ioredis';
import { SignJWT } from 'jose';
import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import request from 'supertest';
import { DataSource, Repository } from 'typeorm';
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
import {
  UserEntity,
  UserStatus,
} from '../src/database/entities/user.entity.js';
import { OAuthAccountEntity } from '../src/database/entities/oauth-account.entity.js';
import { OutboxEventEntity } from '../src/database/entities/outbox-event.entity.js';
import { BadgeEntity } from '../src/database/entities/badge.entity.js';
import { TermEntity } from '../src/database/entities/term.entity.js';
import { UserBadgeEntity } from '../src/database/entities/user-badge.entity.js';
import { UserBlockEntity } from '../src/database/entities/user-block.entity.js';
import { UserTermConsentEntity } from '../src/database/entities/user-term-consent.entity.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from '../src/database/migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';
import { WithdrawalScheduler } from '../src/withdrawal/withdrawal.scheduler.js';
import { UserGrpcServer } from '../src/grpc/user-grpc.server.js';
import { UserQueriesService } from '../src/grpc/user-queries.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { AccessTokenService } from '../src/auth/access-token.service.js';
import { RedisSessionStore } from '../src/auth/redis-session.store.js';
import { KakaoOAuthClient } from '../src/auth/kakao-oauth.client.js';
import {
  createRefreshToken,
  hashRefreshToken,
} from '../src/auth/refresh-token.js';
import { HealthController } from '../src/health/health.controller.js';

type Method = 'GetUserProfile' | 'BatchGetUserProfiles' | 'GetUserStatus';
type Rpc = (
  input: object,
  metadata: Metadata,
  options: { deadline: Date },
  callback: (
    error: ServiceError | null,
    response: Record<string, unknown>,
  ) => void,
) => void;
type UserClient = Client & Record<Method, Rpc>;
const name = `wgo_finalization_test_${process.pid}_${Date.now()}`;
const secret = 'test-user-grpc-secret-at-least-32-characters';
const kakao = {
  exchangeAuthorizationCode: vi.fn().mockResolvedValue('token'),
  getUserId: vi.fn(),
};

describe('Finalization and internal gRPC integration', () => {
  let admin: DataSource;
  let db: DataSource;
  let app: INestApplication;
  let client: UserClient;
  let redis: Redis;
  let config: ConfigService;
  const schedulers: WithdrawalScheduler[] = [];

  beforeAll(async () => {
    const database = configuration().database;
    const options = {
      type: 'postgres' as const,
      host: database.host,
      port: database.port,
      username: database.username,
      password: database.password,
    };
    admin = await new DataSource({
      ...options,
      database: 'postgres',
    }).initialize();
    await admin.query(`CREATE DATABASE "${name}"`);
    db = await new DataSource({
      ...options,
      database: name,
      entities: [...USER_SERVICE_ENTITIES],
      migrations: [
        InitialUserServiceSchema1789990707351,
        AddTermsCodeEffectiveAtIndex1789993249262,
      ],
      synchronize: false,
    }).initialize();
    await db.runMigrations();
    config = new ConfigService({
      grpc: {
        host: '127.0.0.1',
        port: 0,
        package: 'wgo.user.v1',
        protoPath: resolve('contracts/user.proto'),
        serviceJwtSecret: secret,
      },
      redis: { url: 'redis://127.0.0.1:6379/13' },
      auth: {
        refreshTtlSeconds: '86400',
        jwt: {
          accessSecret: secret,
          issuer: 'test',
          audience: 'test',
          accessTtlSeconds: '900',
        },
      },
    });
    const module = await Test.createTestingModule({
      controllers: [AuthController, HealthController],
      providers: [
        UserGrpcServer,
        UserQueriesService,
        AuthService,
        AccessTokenService,
        RedisSessionStore,
        { provide: ConfigService, useValue: config },
        { provide: getDataSourceToken(), useValue: db },
        { provide: KakaoOAuthClient, useValue: kakao },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    const pkg = loadPackageDefinition(
      loadSync(resolve('contracts/user.proto'), {
        defaults: true,
        longs: String,
      }),
    ) as unknown as {
      wgo: {
        user: {
          v1: {
            UserService: new (
              address: string,
              creds: ReturnType<typeof credentials.createInsecure>,
            ) => UserClient;
          };
        };
      };
    };
    client = new pkg.wgo.user.v1.UserService(
      `127.0.0.1:${module.get(UserGrpcServer).port}`,
      credentials.createInsecure(),
    );
    redis = new Redis('redis://127.0.0.1:6379/13');
    await redis.ping();
  }, 30000);

  beforeEach(async () => {
    await db.query(
      'TRUNCATE TABLE users, outbox_events RESTART IDENTITY CASCADE',
    );
    await redis.flushdb(); // Dedicated test DB, separate from auth (15) and outbox (14).
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
  });
  afterEach(async () => {
    await Promise.all(
      schedulers.splice(0).map((scheduler) => scheduler.onModuleDestroy()),
    );
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
  afterAll(async () => {
    client?.close();
    if (app) await app.close();
    if (redis) {
      await redis.flushdb();
      await redis.quit();
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.destroy();
    }
  }, 30000);

  it('finalizes expired users with history preserved and a complete USER_WITHDRAWN envelope', async () => {
    const user = await seed({
      status: UserStatus.WITHDRAWAL_PENDING,
      profileImageKey: 'profiles/private-image',
    });
    const scheduler = makeScheduler();
    const started = Date.now();
    await scheduler.finalizePending();
    const finalized = await row(user.id);
    expect(finalized).toEqual({
      ...user,
      nickname: expect.stringMatching(/^withdrawn_[A-Za-z0-9_-]{20}$/),
      profileImageKey: null,
      status: UserStatus.WITHDRAWN,
      withdrawnAt: expect.any(Date),
      updatedAt: expect.any(Date),
    });
    expect(finalized.nickname).toHaveLength(30);
    expect(finalized.nickname).not.toContain(user.nickname);
    expect(finalized.nickname).toBe(
      `withdrawn_${createHash('sha256').update(user.id).digest('base64url').toLowerCase().slice(0, 20)}`,
    );
    expect(finalized.withdrawnAt!.getTime()).toBeGreaterThanOrEqual(started);
    expect(await db.getRepository(OAuthAccountEntity).find()).toEqual([]);
    const events = await outbox();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      aggregateId: user.id,
      eventType: 'USER_WITHDRAWN',
      status: 'PENDING',
      publishAttempts: 0,
      publishedAt: null,
      createdAt: finalized.withdrawnAt,
    });
    expect(event.payload).toEqual({
      eventId: event.eventId,
      type: event.eventType,
      producer: 'user-service',
      correlationId: expect.stringMatching(/^[0-9a-f-]{36}$/),
      target: { type: 'USER', id: event.aggregateId },
      occurredAt: finalized.withdrawnAt!.toISOString(),
      version: 1,
      payload: {
        userId: user.id,
        withdrawnAt: finalized.withdrawnAt!.toISOString(),
      },
    });
    await scheduler.finalizePending();
    expect(await row(user.id)).toEqual(finalized);
    expect(await outbox()).toEqual(events);
    await expect(
      rpc('GetUserProfile', { userId: user.id }),
    ).rejects.toMatchObject({ code: status.NOT_FOUND });
    expect(await rpc('BatchGetUserProfiles', { userIds: [user.id] })).toEqual({
      profiles: [],
      unavailableUserIds: [user.id],
    });
    expect(await rpc('GetUserStatus', { userId: user.id })).toMatchObject({
      userId: user.id,
      status: 4,
    });
  });

  it('cleans local identity and relations but preserves consent, badge master and Outbox history', async () => {
    const user = await seed({ status: UserStatus.WITHDRAWAL_PENDING });
    const other = await seed();
    const now = new Date();
    const badge = await db
      .getRepository(BadgeEntity)
      .save({
        code: `badge_${randomUUID()}`,
        name: 'Badge',
        description: null,
        imageKey: null,
        active: true,
        createdAt: now,
      });
    const term = await db
      .getRepository(TermEntity)
      .save({
        code: `term_${randomUUID()}`,
        version: '1',
        required: true,
        documentUrl: 'https://example.com/term',
        effectiveAt: now,
        createdAt: now,
      });
    await db
      .getRepository(UserBadgeEntity)
      .save({
        userId: user.id,
        badgeId: badge.id,
        grantedAt: now,
        revokedAt: null,
      });
    await db.getRepository(UserBlockEntity).save([
      { blockerUserId: user.id, blockedUserId: other.id, createdAt: now },
      { blockerUserId: other.id, blockedUserId: user.id, createdAt: now },
    ]);
    await db
      .getRepository(UserTermConsentEntity)
      .save({
        userId: user.id,
        termId: term.id,
        agreedAt: now,
        revokedAt: null,
      });
    const historicalEventId = randomUUID();
    await db
      .getRepository(OutboxEventEntity)
      .save({
        eventId: historicalEventId,
        aggregateId: user.id,
        eventType: 'USER_PROFILE_UPDATED',
        payload: { historical: true },
        status: 'PUBLISHED',
        publishAttempts: 1,
        createdAt: now,
        publishedAt: now,
      });

    await makeScheduler().finalizePending();

    expect(await db.getRepository(UserBlockEntity).find()).toEqual([]);
    expect(
      await db.getRepository(UserBadgeEntity).findBy({ userId: user.id }),
    ).toEqual([]);
    expect(
      await db.getRepository(BadgeEntity).findOneBy({ id: badge.id }),
    ).not.toBeNull();
    expect(
      await db
        .getRepository(UserTermConsentEntity)
        .findOneBy({ userId: user.id, termId: term.id }),
    ).not.toBeNull();
    expect((await outbox()).map((event) => event.eventId)).toEqual(
      expect.arrayContaining([historicalEventId]),
    );
    expect(
      (await outbox()).filter((event) => event.eventType === 'USER_WITHDRAWN'),
    ).toHaveLength(1);
  });

  it('ignores future deadlines, null deadlines, ACTIVE, SUSPENDED, and already WITHDRAWN', async () => {
    const users = await Promise.all([
      seed({
        status: UserStatus.WITHDRAWAL_PENDING,
        withdrawalDeadlineAt: new Date(Date.now() + 60000),
      }),
      seed({
        status: UserStatus.WITHDRAWAL_PENDING,
        withdrawalDeadlineAt: null,
      }),
      seed(),
      seed({ status: UserStatus.SUSPENDED }),
      seed({ status: UserStatus.WITHDRAWN, withdrawnAt: new Date() }),
    ]);
    await makeScheduler().finalizePending();
    for (const user of users) expect(await row(user.id)).toEqual(user);
    expect(await outbox()).toHaveLength(0);
  });

  it('finalizes at the exact deadline and observes batch size and repeat idempotency', async () => {
    const now = new Date();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(now);
    for (let i = 0; i < 3; i++)
      await seed({
        status: UserStatus.WITHDRAWAL_PENDING,
        withdrawalDeadlineAt: now,
      });
    const scheduler = makeScheduler(2);
    await scheduler.finalizePending();
    expect(await outbox()).toHaveLength(2);
    await scheduler.finalizePending();
    expect(await outbox()).toHaveLength(3);
  });

  it('allows two scheduler instances to finalize each user only once', async () => {
    for (let i = 0; i < 4; i++)
      await seed({ status: UserStatus.WITHDRAWAL_PENDING });
    await Promise.all([
      makeScheduler(2).finalizePending(),
      makeScheduler(2).finalizePending(),
    ]);
    const events = await outbox();
    expect(events).toHaveLength(4);
    expect(new Set(events.map((event) => event.aggregateId)).size).toBe(4);
    const tombstones = (
      await db
        .getRepository(UserEntity)
        .findBy({ status: UserStatus.WITHDRAWN })
    ).map((user) => user.nickname.toLowerCase());
    expect(new Set(tombstones).size).toBe(4);
    expect(tombstones.every((nickname) => nickname.length === 30)).toBe(true);
  });

  it('rolls back user changes and all events when Outbox insertion fails', async () => {
    const user = await seed({ status: UserStatus.WITHDRAWAL_PENDING });
    const other = await seed();
    const now = new Date();
    const badge = await db
      .getRepository(BadgeEntity)
      .save({
        code: `rollback_${randomUUID()}`,
        name: 'Badge',
        description: null,
        imageKey: null,
        active: true,
        createdAt: now,
      });
    await db
      .getRepository(UserBadgeEntity)
      .save({
        userId: user.id,
        badgeId: badge.id,
        grantedAt: now,
        revokedAt: null,
      });
    await db
      .getRepository(UserBlockEntity)
      .save({
        blockerUserId: user.id,
        blockedUserId: other.id,
        createdAt: now,
      });
    await db.query(
      'ALTER TABLE outbox_events ADD CONSTRAINT test_reject_finalization CHECK (false)',
    );
    try {
      await makeScheduler().finalizePending();
      expect(await row(user.id)).toEqual(user);
      expect(
        await db
          .getRepository(OAuthAccountEntity)
          .findOneBy({ userId: user.id }),
      ).not.toBeNull();
      expect(
        await db.getRepository(UserBadgeEntity).findOneBy({ userId: user.id }),
      ).not.toBeNull();
      expect(
        await db
          .getRepository(UserBlockEntity)
          .findOneBy({ blockerUserId: user.id }),
      ).not.toBeNull();
      expect(await outbox()).toHaveLength(0);
    } finally {
      await db.query(
        'ALTER TABLE outbox_events DROP CONSTRAINT test_reject_finalization',
      );
    }
    await makeScheduler().finalizePending();
    expect((await row(user.id)).status).toBe(UserStatus.WITHDRAWN);
  });

  it('does not depend on Redis cleanup and rejects stale refresh after finalization', async () => {
    const user = await seed({ status: UserStatus.WITHDRAWAL_PENDING });
    const sid = randomUUID();
    const token = createRefreshToken(sid);
    await app
      .get(RedisSessionStore)
      .save({
        sessionId: sid,
        userId: user.id,
        refreshTokenHash: hashRefreshToken(token),
        createdAt: new Date().toISOString(),
      });
    const cleanup = vi
      .spyOn(app.get(RedisSessionStore), 'deleteAllSessionsForUser')
      .mockRejectedValue(new Error('offline'));
    await makeScheduler().finalizePending();
    expect(cleanup).not.toHaveBeenCalled();
    expect((await row(user.id)).status).toBe(UserStatus.WITHDRAWN);
    await request(app.getHttpServer())
      .post('/api/v1/auth/refresh')
      .send({ refreshToken: token })
      .expect(401);
  });

  it('creates a fresh WGO account when the same Kakao identity logs in after finalization', async () => {
    const providerUserId = `kakao_${randomUUID()}`;
    const oldUser = await seed(
      { status: UserStatus.WITHDRAWAL_PENDING },
      providerUserId,
    );
    await makeScheduler().finalizePending();
    kakao.getUserId.mockResolvedValue(providerUserId);

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: 'code' })
      .expect(201);

    expect(response.body).toMatchObject({
      isNewUser: true,
      onboardingRequired: true,
      restoredFromWithdrawal: false,
    });
    expect(response.body.userId).toMatch(/^[1-9][0-9]*$/);
    expect(response.body.userId).not.toBe(oldUser.id);
    expect((await row(oldUser.id)).status).toBe(UserStatus.WITHDRAWN);
    const account = await db
      .getRepository(OAuthAccountEntity)
      .findOneByOrFail({ provider: 'KAKAO', providerUserId });
    expect(account.userId).toBe(response.body.userId);
  });

  it.each(['restore', 'scheduler'] as const)(
    'serializes the race when %s acquires the user lock first',
    async (winner) => {
      const now = new Date();
      vi.useFakeTimers({ toFake: ['Date'] });
      vi.setSystemTime(now);
      const user = await seed({
        status: UserStatus.WITHDRAWAL_PENDING,
        withdrawalDeadlineAt: new Date(
          now.getTime() + (winner === 'restore' ? 1000 : -1000),
        ),
      });
      kakao.getUserId.mockResolvedValue(user.id);
      const entered = deferred();
      const release = deferred();
      const insert = Repository.prototype.insert;
      vi.spyOn(Repository.prototype, 'insert').mockImplementationOnce(
        async function (this: Repository<OutboxEventEntity>, value) {
          // Both transitions insert Outbox only after taking the real PostgreSQL user lock.
          entered.resolve();
          await release.promise;
          return insert.call(this, value);
        },
      );
      const scheduler = makeScheduler();
      const login = () =>
        request(app.getHttpServer())
          .post('/api/v1/auth/kakao')
          .send({ authorizationCode: 'code' })
          .then((r) => r);
      if (winner === 'restore') {
        const restoring = login();
        await entered.promise;
        try {
          vi.setSystemTime(new Date(now.getTime() + 2000));
          await scheduler.finalizePending(); // Expired old row is locked; SKIP LOCKED must skip it.
          expect(await outbox()).toHaveLength(0);
        } finally {
          release.resolve();
        }
        expect((await restoring).status).toBe(201);
        await scheduler.finalizePending();
        expect((await row(user.id)).status).toBe(UserStatus.ACTIVE);
      } else {
        const finalizing = scheduler.finalizePending();
        await entered.promise;
        const restoring = login();
        release.resolve();
        await finalizing;
        const registered = await restoring;
        expect(registered.status).toBe(201);
        expect(registered.body).toMatchObject({
          isNewUser: true,
          onboardingRequired: true,
          restoredFromWithdrawal: false,
        });
        expect(registered.body.userId).toMatch(/^[1-9][0-9]*$/);
        expect(registered.body.userId).not.toBe(user.id);
        expect((await row(user.id)).status).toBe(UserStatus.WITHDRAWN);
      }
      expect((await outbox()).map((event) => event.eventType)).toEqual([
        winner === 'restore' ? 'USER_RESTORED' : 'USER_WITHDRAWN',
      ]);
    },
  );

  it('starts polling, retries errors, and stops on shutdown', async () => {
    const scheduler = makeScheduler(20, 25);
    vi.spyOn(db, 'transaction').mockRejectedValueOnce(new Error('offline'));
    scheduler.onApplicationBootstrap();
    const user = await seed({ status: UserStatus.WITHDRAWAL_PENDING });
    await vi.waitFor(
      async () =>
        expect((await row(user.id)).status).toBe(UserStatus.WITHDRAWN),
      { timeout: 2000 },
    );
    await scheduler.onModuleDestroy();
    const next = await seed({ status: UserStatus.WITHDRAWAL_PENDING });
    await scheduler.finalizePending();
    expect(await row(next.id)).toEqual(next);
  });

  it('serves a display profile over the actual gRPC server while HTTP remains available', async () => {
    const user = await seed({ profileImageKey: 'profiles/image' });
    expect(await rpc('GetUserProfile', { userId: user.id })).toEqual({
      userId: user.id,
      nickname: user.nickname,
      status: 1,
      profileImageKey: 'profiles/image',
    });
    await request(app.getHttpServer()).get('/health/live').expect(200);
    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({})
      .expect(400);
  });

  it('maps a suspended profile to the canonical enum value', async () => {
    const user = await seed({ status: UserStatus.SUSPENDED });
    expect(await rpc('GetUserProfile', { userId: user.id })).toMatchObject({
      status: 2,
    });
  });

  it('preserves absent nullable fields and hides unavailable profiles', async () => {
    const user = await seed();
    expect(await rpc('GetUserProfile', { userId: user.id })).not.toHaveProperty(
      'profileImageKey',
    );
    await expect(
      rpc('GetUserProfile', { userId: '9007199254740991' }),
    ).rejects.toMatchObject({ code: status.NOT_FOUND });
    const incomplete = await seed({ onboardingCompletedAt: null });
    await expect(
      rpc('GetUserProfile', { userId: incomplete.id }),
    ).rejects.toMatchObject({ code: status.FAILED_PRECONDITION });
    const withdrawn = await seed({ status: UserStatus.WITHDRAWN });
    await expect(
      rpc('GetUserProfile', { userId: withdrawn.id }),
    ).rejects.toMatchObject({ code: status.NOT_FOUND });
  });

  it('batch-queries once, deduplicates IDs, keeps request order and reports unavailable IDs', async () => {
    const a = await seed();
    const b = await seed();
    const missing = '9007199254740991';
    const incomplete = await seed({ onboardingCompletedAt: null });
    const withdrawn = await seed({ status: UserStatus.WITHDRAWN });
    const query = vi.spyOn(db.logger, 'logQuery');
    expect(
      await rpc('BatchGetUserProfiles', {
        userIds: [b.id, missing, a.id, b.id, incomplete.id, withdrawn.id],
      }),
    ).toEqual({
      profiles: [b, a].map((user) => ({
        userId: user.id,
        nickname: user.nickname,
        status: 1,
      })),
      unavailableUserIds: [missing, incomplete.id, withdrawn.id],
    });
    const selects = query.mock.calls.filter(
      ([sql]) => sql.startsWith('SELECT') && sql.includes('"users"'),
    );
    expect(selects).toHaveLength(1);
    expect(selects[0]![0]).toContain(' IN ');
  });

  it('accepts 100 batch IDs but rejects an empty batch, 101 IDs and out-of-range IDs', async () => {
    const user = await seed();
    expect(
      await rpc('BatchGetUserProfiles', { userIds: Array(100).fill(user.id) }),
    ).toEqual({
      profiles: [{ userId: user.id, nickname: user.nickname, status: 1 }],
      unavailableUserIds: [],
    });
    await expect(
      rpc('BatchGetUserProfiles', { userIds: [] }),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    await expect(
      rpc('BatchGetUserProfiles', { userIds: Array(101).fill('1') }),
    ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    for (const value of ['0', '-1', '9007199254740992']) {
      for (const method of ['GetUserProfile', 'GetUserStatus'] as const) {
        await expect(rpc(method, { userId: value })).rejects.toMatchObject({
          code: status.INVALID_ARGUMENT,
        });
      }
      await expect(
        rpc('BatchGetUserProfiles', { userIds: [value] }),
      ).rejects.toMatchObject({ code: status.INVALID_ARGUMENT });
    }
  });

  it.each([
    [UserStatus.ACTIVE, 1],
    [UserStatus.SUSPENDED, 2],
    [UserStatus.WITHDRAWAL_PENDING, 3],
    [UserStatus.WITHDRAWN, 4],
  ] as const)(
    'reads %s status from PostgreSQL as enum %s, even before onboarding',
    async (accountStatus, grpcStatus) => {
      const until =
        accountStatus === UserStatus.SUSPENDED
          ? new Date(Date.now() + 60000)
          : null;
      const user = await seed({
        status: accountStatus,
        suspendedUntil: until,
        onboardingCompletedAt: null,
      });
      expect(await rpc('GetUserStatus', { userId: user.id })).toEqual({
        userId: user.id,
        status: grpcStatus,
        ...(until ? { suspendedUntil: toTimestamp(until) } : {}),
      });
    },
  );

  it('keeps the canonical UserStatus enum numbers', () => {
    const definition = loadSync(resolve('contracts/user.proto')) as Record<
      string,
      { type?: { value?: Array<{ name: string; number: number }> } }
    >;
    expect(
      definition['wgo.user.v1.UserStatus']?.type?.value?.map(
        ({ name, number }) => ({ name, number }),
      ),
    ).toEqual([
      { name: 'USER_STATUS_UNSPECIFIED', number: 0 },
      { name: 'ACTIVE', number: 1 },
      { name: 'SUSPENDED', number: 2 },
      { name: 'WITHDRAWAL_PENDING', number: 3 },
      { name: 'WITHDRAWN', number: 4 },
    ]);
  });

  it('reports missing users and database outages without exposing internals', async () => {
    await expect(
      rpc('GetUserStatus', { userId: '9007199254740991' }),
    ).rejects.toMatchObject({ code: status.NOT_FOUND });
    vi.spyOn(Repository.prototype, 'findOneBy').mockRejectedValueOnce(
      new Error('private SQL detail'),
    );
    await expect(
      rpc('GetUserStatus', { userId: '9007199254740991' }),
    ).rejects.toMatchObject({
      code: status.UNAVAILABLE,
      details: 'User store unavailable',
    });
  });

  it('rejects unauthenticated calls, wrong audience and untrusted service callers', async () => {
    await expect(
      rpc('GetUserStatus', { userId: '1' }, new Metadata()),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
    await expect(
      rpc(
        'GetUserStatus',
        { userId: '1' },
        await auth('post-service', 'wrong'),
      ),
    ).rejects.toMatchObject({ code: status.UNAUTHENTICATED });
    await expect(
      rpc('GetUserStatus', { userId: '1' }, await auth('unknown-service')),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
    const configured = config.get('grpc.serviceJwtSecret');
    config.set('grpc.serviceJwtSecret', undefined);
    try {
      await expect(rpc('GetUserStatus', { userId: '1' })).rejects.toMatchObject(
        { code: status.UNAUTHENTICATED },
      );
    } finally {
      config.set('grpc.serviceJwtSecret', configured);
    }
  });

  it('authorizes callers per RPC', async () => {
    const user = await seed();
    await expect(
      rpc('GetUserStatus', { userId: user.id }, await auth('post-service')),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
    await expect(
      rpc('GetUserProfile', { userId: user.id }, await auth('ws-gateway')),
    ).rejects.toMatchObject({ code: status.PERMISSION_DENIED });
    expect(
      await rpc(
        'GetUserProfile',
        { userId: user.id },
        await auth('post-service'),
      ),
    ).toMatchObject({ status: 1 });
    expect(
      await rpc('GetUserStatus', { userId: user.id }, await auth('ws-gateway')),
    ).toMatchObject({ status: 1 });
  });

  function makeScheduler(batchSize = 20, pollIntervalMs = 60000) {
    const scheduler = new WithdrawalScheduler(
      db,
      new ConfigService({ withdrawal: { batchSize, pollIntervalMs } }),
    );
    schedulers.push(scheduler);
    return scheduler;
  }
  async function seed(
    overrides: Partial<UserEntity> = {},
    providerUserId?: string,
  ) {
    const now = new Date();
    const user = db.getRepository(UserEntity).create({
      nickname: `test_${randomUUID().slice(0, 8)}`,
      status: UserStatus.ACTIVE,
      profileImageKey: null,
      onboardingCompletedAt: now,
      suspendedUntil: null,
      withdrawalRequestedAt: new Date(now.getTime() - 30 * 86400000),
      withdrawalDeadlineAt: new Date(now.getTime() - 1000),
      withdrawnAt: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    });
    await db.getRepository(UserEntity).save(user);
    await db
      .getRepository(OAuthAccountEntity)
      .save({
        id: randomUUID(),
        userId: user.id,
        provider: 'KAKAO',
        providerUserId: providerUserId ?? user.id,
        providerEmail: null,
        createdAt: now,
        updatedAt: now,
      });
    return row(user.id);
  }
  function row(id: string) {
    return db.getRepository(UserEntity).findOneByOrFail({ id });
  }
  function outbox() {
    return db.getRepository(OutboxEventEntity).find();
  }
  async function auth(subject = 'post-service', audience = 'wgo-user-service') {
    const now = Math.floor(Date.now() / 1000);
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
      .setSubject(subject)
      .setIssuer(`wgo-${subject}`)
      .setAudience(audience)
      .setIssuedAt(now)
      .setExpirationTime(now + 30)
      .sign(new TextEncoder().encode(secret));
    const metadata = new Metadata();
    metadata.set('authorization', `Bearer ${token}`);
    return metadata;
  }
  async function rpc(
    method: Method,
    input: object,
    metadata?: Metadata,
  ): Promise<Record<string, unknown>> {
    const headers =
      metadata ??
      (await auth(method === 'GetUserStatus' ? 'ws-gateway' : 'post-service'));
    return new Promise((done, reject) =>
      client[method](
        input,
        headers,
        { deadline: new Date(Date.now() + 2000) },
        (error, response) => (error ? reject(error) : done(response)),
      ),
    );
  }
  function toTimestamp(value: Date) {
    return {
      seconds: String(Math.floor(value.getTime() / 1000)),
      nanos: (value.getTime() % 1000) * 1_000_000,
    };
  }
  function deferred() {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }
});
