import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { Redis } from 'ioredis';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import { DataSource } from 'typeorm';
import { jwtVerify } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { AccessTokenService } from '../src/auth/access-token.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { KakaoOAuthClient } from '../src/auth/kakao-oauth.client.js';
import { createRefreshToken, hashRefreshToken, parseRefreshToken } from '../src/auth/refresh-token.js';
import { RedisSessionStore } from '../src/auth/redis-session.store.js';
import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { OAuthAccountEntity } from '../src/database/entities/oauth-account.entity.js';
import { UserEntity, UserStatus } from '../src/database/entities/user.entity.js';
import { OutboxEventEntity } from '../src/database/entities/outbox-event.entity.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from '../src/database/migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';

const testDatabaseName = `wgo_auth_test_${process.pid}_${Date.now()}`;
const redisUrl = 'redis://localhost:6379/15';
const accessSecret = 'test-access-secret-with-sufficient-entropy';
const accessTtlSeconds = 900;
const refreshTtlSeconds = 86_400;

const kakaoOAuthClient = {
  exchangeAuthorizationCode: vi.fn<(authorizationCode: string) => Promise<string>>(),
  getUserId: vi.fn<(accessToken: string) => Promise<string>>(),
};

describe('Auth API integration', () => {
  let adminDataSource: DataSource;
  let testDataSource: DataSource;
  let redis: Redis;
  let sessionStore: RedisSessionStore;
  let app: INestApplication;

  beforeAll(async () => {
    const database = configuration().database;
    adminDataSource = new DataSource({
      type: 'postgres',
      host: database.host,
      port: database.port,
      username: database.username,
      password: database.password,
      database: 'postgres',
    });
    await adminDataSource.initialize();
    await adminDataSource.query(`CREATE DATABASE "${testDatabaseName}"`);

    testDataSource = new DataSource({
      type: 'postgres',
      host: database.host,
      port: database.port,
      username: database.username,
      password: database.password,
      database: testDatabaseName,
      entities: [...USER_SERVICE_ENTITIES],
      migrations: [
        InitialUserServiceSchema1789990707351,
        AddTermsCodeEffectiveAtIndex1789993249262,
      ],
      synchronize: false,
    });
    await testDataSource.initialize();
    await testDataSource.runMigrations();

    const configService = new ConfigService({
      redis: { url: redisUrl },
      auth: {
        jwt: {
          accessSecret,
          issuer: 'wgo-user-service-test',
          audience: 'wgo-api-test',
          accessTtlSeconds: String(accessTtlSeconds),
        },
        refreshTtlSeconds: String(refreshTtlSeconds),
      },
    });
    const module = await Test.createTestingModule({
      controllers: [AuthController, UsersController],
      providers: [
        AuthService,
        UsersService,
        { provide: getRepositoryToken(UserEntity), useValue: testDataSource.getRepository(UserEntity) },
        AccessTokenService,
        RedisSessionStore,
        { provide: ConfigService, useValue: configService },
        { provide: getDataSourceToken(), useValue: testDataSource },
        { provide: KakaoOAuthClient, useValue: kakaoOAuthClient },
      ],
    }).compile();

    sessionStore = module.get(RedisSessionStore);
    app = module.createNestApplication();
    await app.init();
    redis = new Redis(redisUrl);
    await redis.ping();
  }, 30_000);

  afterAll(async () => {
    if (redis) {
      await redis.flushdb();
      await redis.quit();
    }
    if (app) {
      await app.close();
    }
    if (testDataSource?.isInitialized) {
      await testDataSource.destroy();
    }
    if (adminDataSource?.isInitialized) {
      await adminDataSource.query(`DROP DATABASE "${testDatabaseName}" WITH (FORCE)`);
      await adminDataSource.destroy();
    }
  }, 30_000);

  beforeEach(async () => {
    vi.restoreAllMocks();
    kakaoOAuthClient.exchangeAuthorizationCode.mockReset().mockResolvedValue('kakao-access-token');
    kakaoOAuthClient.getUserId.mockReset().mockResolvedValue('12345678901234567890');
    await testDataSource.query('TRUNCATE TABLE "users" CASCADE');
    await testDataSource.query('TRUNCATE TABLE "outbox_events"');
    await redis.flushdb();
  });

  it('rejects a missing or blank authorizationCode', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/kakao').send({}).expect(400);
    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: '   ' })
      .expect(400);
  });

  it('maps a Kakao token exchange failure to 401', async () => {
    kakaoOAuthClient.exchangeAuthorizationCode.mockRejectedValueOnce(
      new UnauthorizedException('Kakao authentication failed'),
    );

    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: 'invalid-code' })
      .expect(401);
  });

  it('maps a Kakao user lookup failure to 401', async () => {
    kakaoOAuthClient.getUserId.mockRejectedValueOnce(
      new UnauthorizedException('Kakao authentication failed'),
    );

    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: 'code' })
      .expect(401);
  });

  it('creates a new user, OAuth account, JWT, and hashed Redis session', async () => {
    const response = await login();

    expect(response.body).toMatchObject({
      isNewUser: true,
      onboardingRequired: true,
      restoredFromWithdrawal: false,
      expiresIn: accessTtlSeconds,
    });
    expect(response.body.userId).toEqual(expect.any(String));
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(Object.keys(response.body).sort()).toEqual([
      'accessToken', 'expiresIn', 'isNewUser', 'onboardingRequired', 'refreshToken', 'restoredFromWithdrawal', 'userId',
    ]);

    const users = await testDataSource.getRepository(UserEntity).find();
    const accounts = await testDataSource.getRepository(OAuthAccountEntity).find();
    expect(users).toHaveLength(1);
    expect(users[0]).toMatchObject({
      id: response.body.userId,
      status: UserStatus.ACTIVE,
      onboardingCompletedAt: null,
    });
    expect(users[0]?.nickname).toHaveLength(29);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]).toMatchObject({
      userId: response.body.userId,
      provider: 'KAKAO',
      providerUserId: '12345678901234567890',
      providerEmail: null,
    });

    const verified = await jwtVerify(
      response.body.accessToken as string,
      new TextEncoder().encode(accessSecret),
      { issuer: 'wgo-user-service-test', audience: 'wgo-api-test' },
    );
    expect(verified.payload.sub).toBe(response.body.userId);
    expect(verified.payload.sid).toEqual(expect.any(String));
    expect(verified.payload.iat).toEqual(expect.any(Number));
    expect(verified.payload.exp).toBe((verified.payload.iat as number) + accessTtlSeconds);
    expect(Object.keys(verified.payload).sort()).toEqual(['aud', 'exp', 'iat', 'iss', 'sid', 'sub']);

    const sessionId = verified.payload.sid as string;
    expect(parseRefreshToken(response.body.refreshToken as string)).toBe(sessionId);
    expect(response.body.refreshToken).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{43}$/,
    );
    const sessionKey = RedisSessionStore.sessionKey(sessionId);
    const storedRaw = await redis.get(sessionKey);
    const stored = JSON.parse(storedRaw ?? '{}') as Record<string, unknown>;
    expect(stored).toMatchObject({ sessionId, userId: response.body.userId });
    expect(stored.refreshTokenHash).toBe(
      createHash('sha256').update(response.body.refreshToken as string).digest('hex'),
    );
    expect(storedRaw).not.toContain(response.body.refreshToken as string);
    expect(storedRaw).not.toContain((response.body.refreshToken as string).split('.')[1]!);
    expect(await redis.ttl(sessionKey)).toBeGreaterThan(0);
    expect(await redis.ttl(sessionKey)).toBeLessThanOrEqual(refreshTtlSeconds);
    expect(
      await redis.sismember(
        RedisSessionStore.userSessionsKey(response.body.userId as string),
        sessionId,
      ),
    ).toBe(1);
  });

  it('reuses an existing user and reports completed onboarding', async () => {
    const user = await insertAccount({ onboardingCompletedAt: new Date() });

    const response = await login();

    expect(response.body).toMatchObject({
      userId: user.id,
      isNewUser: false,
      onboardingRequired: false,
      restoredFromWithdrawal: false,
    });
    expect(await testDataSource.getRepository(UserEntity).count()).toBe(1);
    expect(await testDataSource.getRepository(OAuthAccountEntity).count()).toBe(1);
  });

  it('requires onboarding for an existing user without onboarding completion', async () => {
    const user = await insertAccount();

    const response = await login();

    expect(response.body).toMatchObject({
      userId: user.id,
      isNewUser: false,
      onboardingRequired: true,
    });
  });

  it('creates another session on repeated login without duplicating the account', async () => {
    const first = await login();
    const second = await login();

    expect(second.body).toMatchObject({ userId: first.body.userId, isNewUser: false });
    expect(second.body.refreshToken).not.toBe(first.body.refreshToken);
    expect(await testDataSource.getRepository(UserEntity).count()).toBe(1);
    expect(await testDataSource.getRepository(OAuthAccountEntity).count()).toBe(1);
    expect(
      await redis.scard(RedisSessionStore.userSessionsKey(first.body.userId as string)),
    ).toBe(2);
  });

  it('handles concurrent first logins through the OAuth unique constraint', async () => {
    const [first, second] = await Promise.all([login(), login()]);

    expect(first.body.userId).toBe(second.body.userId);
    expect([first.body.isNewUser, second.body.isNewUser].sort()).toEqual([false, true]);
    expect(await testDataSource.getRepository(UserEntity).count()).toBe(1);
    expect(await testDataSource.getRepository(OAuthAccountEntity).count()).toBe(1);
  });

  it('rejects non-active existing users', async () => {
    await insertAccount({ status: UserStatus.SUSPENDED });

    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: 'code' })
      .expect(401);
  });

  it('returns 503 and no tokens when Redis session storage fails', async () => {
    vi.spyOn(sessionStore, 'save').mockRejectedValueOnce(new Error('Redis unavailable'));

    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: 'code' })
      .expect(503);

    expect(response.body).not.toHaveProperty('accessToken');
    expect(response.body).not.toHaveProperty('refreshToken');
    expect(await testDataSource.getRepository(UserEntity).count()).toBe(1);
    expect(await testDataSource.getRepository(OAuthAccountEntity).count()).toBe(1);
  });

  function login(): request.Test {
    return request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: ' code ' })
      .expect(201);
  }

  it('refreshes without Access JWT, rotates the secret and preserves session expiration', async () => {
    const loginResponse = await login();
    const token = loginResponse.body.refreshToken as string;
    const sid = parseRefreshToken(token)!;
    const key = RedisSessionStore.sessionKey(sid);
    const indexKey = RedisSessionStore.userSessionsKey(loginResponse.body.userId as string);
    await redis.expire(key, 120);
    const deadline = await redis.call('PEXPIRETIME', key);
    const indexDeadline = await redis.call('PEXPIRETIME', indexKey);
    const before = await sessionStore.find(sid);

    const response = await refresh(token).expect(200);
    expect(Object.keys(response.body).sort()).toEqual(['accessToken', 'expiresIn', 'refreshToken']);
    expect(response.body.expiresIn).toBe(accessTtlSeconds);
    const { payload } = await jwtVerify(response.body.accessToken as string,
      new TextEncoder().encode(accessSecret), {
        algorithms: ['HS256'], issuer: 'wgo-user-service-test', audience: 'wgo-api-test',
      });
    expect(payload.sub).toBe(loginResponse.body.userId);
    expect(payload.sid).toBe(sid);
    expect(payload.exp! - payload.iat!).toBe(accessTtlSeconds);
    expect(parseRefreshToken(response.body.refreshToken as string)).toBe(sid);
    expect((response.body.refreshToken as string).split('.')[1]).not.toBe(token.split('.')[1]);
    const raw = (await redis.get(key))!;
    expect(JSON.parse(raw)).toEqual({ ...before,
      refreshTokenHash: hashRefreshToken(response.body.refreshToken as string) });
    expect(raw).not.toContain(token);
    expect(raw).not.toContain(response.body.refreshToken as string);
    expect(await redis.call('PEXPIRETIME', key)).toBe(deadline);
    expect(await redis.call('PEXPIRETIME', indexKey)).toBe(indexDeadline);
    expect(await redis.smembers(indexKey)).toEqual([sid]);
    await refresh(token).expect(401);
    await refresh(response.body.refreshToken as string).expect(200);
  });

  it.each([{}, { refreshToken: null }, { refreshToken: 123 },
    { refreshToken: '' }, { refreshToken: 'malformed' }])('rejects invalid refresh body %j', async (body) => {
    await request(app.getHttpServer()).post('/api/v1/auth/refresh').send(body).expect(401);
  });

  it('rejects missing sessions and mismatched hashes', async () => {
    await refresh(createRefreshToken(randomUUID())).expect(401);
    const response = await login();
    const sid = parseRefreshToken(response.body.refreshToken as string)!;
    await refresh(createRefreshToken(sid)).expect(401);
    await refresh(response.body.refreshToken as string).expect(200);
  });

  it.each(['expired', 'no-ttl', 'below-one-second'])('rejects %s sessions', async (mode) => {
    const response = await login();
    const key = RedisSessionStore.sessionKey(parseRefreshToken(response.body.refreshToken as string)!);
    if (mode === 'expired') await redis.pexpire(key, 0);
    else if (mode === 'no-ttl') await redis.persist(key);
    else await redis.pexpire(key, 400);
    await refresh(response.body.refreshToken as string).expect(401);
  });

  it('allows only one concurrent refresh using the same old token', async () => {
    const response = await login();
    const responses = await Promise.all([
      refresh(response.body.refreshToken as string), refresh(response.body.refreshToken as string),
    ]);
    expect(responses.map((item) => item.status).sort()).toEqual([200, 401]);
    await refresh(responses.find((item) => item.status === 200)!.body.refreshToken as string).expect(200);
  });

  it.each(['find', 'rotate'] as const)('returns 503 for Redis %s failure during refresh', async (method) => {
    const response = await login();
    vi.spyOn(sessionStore, method).mockRejectedValueOnce(new Error('Redis unavailable'));
    const failed = await refresh(response.body.refreshToken as string).expect(503);
    expect(failed.body).not.toHaveProperty('accessToken');
  });

  it('logs out only the current session, supports repeat logout and rejects its refresh token', async () => {
    const first = await login();
    const second = await login();
    const sid = parseRefreshToken(first.body.refreshToken as string)!;
    const otherSid = parseRefreshToken(second.body.refreshToken as string)!;
    const userId = first.body.userId as string;
    await logout(userId, sid).expect(204).expect('');
    expect(await redis.get(RedisSessionStore.sessionKey(sid))).toBeNull();
    expect(await redis.smembers(RedisSessionStore.userSessionsKey(userId))).toEqual([otherSid]);
    expect(await redis.exists(RedisSessionStore.sessionKey(otherSid))).toBe(1);
    await logout(userId, sid).expect(204);
    await refresh(first.body.refreshToken as string).expect(401);
    await refresh(second.body.refreshToken as string).expect(200);
    await logout(userId, otherSid).expect(204);
    expect(await redis.exists(RedisSessionStore.userSessionsKey(userId))).toBe(0);
  });

  it('does not delete a session belonging to another user', async () => {
    const response = await login();
    const sid = parseRefreshToken(response.body.refreshToken as string)!;
    await logout(randomUUID(), sid).expect(401);
    expect(await redis.sismember(RedisSessionStore.userSessionsKey(response.body.userId as string), sid)).toBe(1);
    await refresh(response.body.refreshToken as string).expect(200);
  });

  it('requires valid internal context for logout', async () => {
    await request(app.getHttpServer()).post('/api/v1/auth/logout').expect(401);
    await logout('invalid', randomUUID()).expect(401);
    await logout(randomUUID(), 'invalid').expect(401);
  });

  it('returns 503 for Redis failure during logout', async () => {
    const response = await login();
    const sid = parseRefreshToken(response.body.refreshToken as string)!;
    vi.spyOn(sessionStore, 'deleteSession').mockRejectedValueOnce(new Error('Redis unavailable'));
    await logout(response.body.userId as string, sid).expect(503);
    expect(await redis.exists(RedisSessionStore.sessionKey(sid))).toBe(1);
  });

  it('cannot rotate a session deleted after it was read', async () => {
    const response = await login();
    const sid = parseRefreshToken(response.body.refreshToken as string)!;
    const snapshot = (await sessionStore.find(sid))!;
    await logout(response.body.userId as string, sid).expect(204);
    expect(await sessionStore.rotate(snapshot, hashRefreshToken(createRefreshToken(sid)))).toBe(false);
    expect(await redis.exists(RedisSessionStore.sessionKey(sid))).toBe(0);
  });

  describe('withdrawal lifecycle', () => {
    it('withdraws once, stores the complete envelope and removes only this user\'s sessions', async () => {
      const first = await login();
      const second = await login();
      const userId = first.body.userId as string;
      const before = await findUser(userId);
      const other = await testDataSource.getRepository(UserEntity).save({
        ...before, id: randomUUID(), nickname: 'OtherUser',
      });
      const otherSid = randomUUID();
      await sessionStore.save({ sessionId: otherSid, userId: other.id,
        refreshTokenHash: hashRefreshToken(createRefreshToken(otherSid)), createdAt: new Date().toISOString() });
      // User session indexes may retain IDs after the session TTL expires.
      await redis.sadd(RedisSessionStore.userSessionsKey(userId), randomUUID());

      const startedAt = Date.now();
      const response = await withdraw(userId).set('x-request-id', 'withdrawal-request').expect(200);
      const user = await findUser(userId);
      expect(user.status).toBe(UserStatus.WITHDRAWAL_PENDING);
      expect(user.withdrawalRequestedAt!.getTime()).toBeGreaterThanOrEqual(startedAt);
      expect(user.withdrawalRequestedAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(user.withdrawalDeadlineAt!.getTime() - user.withdrawalRequestedAt!.getTime())
        .toBe(30 * 24 * 60 * 60 * 1000);
      expect(user.withdrawnAt).toEqual(before.withdrawnAt);
      expect(user.onboardingCompletedAt).toEqual(before.onboardingCompletedAt);
      expect(response.body).toEqual({ status: 'WITHDRAWAL_PENDING',
        recoverableUntil: user.withdrawalDeadlineAt!.toISOString() });
      const events = await outbox();
      expect(events).toHaveLength(1);
      expectEnvelope(events[0]!, userId, 'USER_WITHDRAWAL_STARTED', 'withdrawal-request', {
        userId, recoverableUntil: user.withdrawalDeadlineAt!.toISOString(),
      });
      for (const result of [first, second]) {
        const sid = parseRefreshToken(result.body.refreshToken as string)!;
        expect(await sessionStore.find(sid)).toBeNull();
        await refresh(result.body.refreshToken as string).expect(401);
      }
      expect(await redis.exists(RedisSessionStore.userSessionsKey(userId))).toBe(0);
      expect(await sessionStore.find(otherSid)).not.toBeNull();
      expect(await redis.smembers(RedisSessionStore.userSessionsKey(other.id))).toEqual([otherSid]);
      // Withdrawal does not blacklist already-issued short-lived access tokens.
      await jwtVerify(first.body.accessToken as string, new TextEncoder().encode(accessSecret));

      await withdraw(userId).expect(200).expect(response.body);
      expect(await findUser(userId)).toEqual(user);
      expect(await outbox()).toEqual(events);
    });

    it('serializes concurrent withdrawal without sessions and sets the deadline only once', async () => {
      const user = await insertAccount();
      const [first, second] = await Promise.all([withdraw(user.id).expect(200), withdraw(user.id).expect(200)]);
      expect(first.body).toEqual(second.body);
      expect((await findUser(user.id)).status).toBe(UserStatus.WITHDRAWAL_PENDING);
      const events = await outbox();
      expect(events).toHaveLength(1);
      expectEnvelope(events[0]!, user.id, 'USER_WITHDRAWAL_STARTED', undefined, {
        userId: user.id, recoverableUntil: first.body.recoverableUntil,
      });
    });

    it('requires internal user context and an existing user', async () => {
      await request(app.getHttpServer()).post('/api/v1/users/me/withdrawal').expect(401);
      await withdraw('invalid').expect(401);
      await withdraw(randomUUID()).expect(404);
      expect(await outbox()).toHaveLength(0);
    });

    it.each([UserStatus.SUSPENDED, UserStatus.WITHDRAWN])('rejects withdrawal from %s', async (status) => {
      const user = await insertAccount({ status });
      await withdraw(user.id).expect(409);
      expect(await findUser(user.id)).toEqual(user);
      expect(await outbox()).toHaveLength(0);
    });

    it('rolls back status and Outbox on Redis cleanup failure and permits retry', async () => {
      const response = await login();
      const id = response.body.userId as string;
      const before = await findUser(id);
      vi.spyOn(sessionStore, 'deleteAllSessionsForUser').mockRejectedValueOnce(new Error('Redis unavailable'));
      await withdraw(id).expect(503);
      expect(await findUser(id)).toEqual(before);
      expect(await outbox()).toHaveLength(0);
      expect(await sessionStore.find(parseRefreshToken(response.body.refreshToken as string)!)).not.toBeNull();
      await withdraw(id).expect(200);
      await refresh(response.body.refreshToken as string).expect(401);
    });

    it('restores through Kakao, preserves profile/onboarding and issues a new session after commit', async () => {
      const original = await login();
      const id = original.body.userId as string;
      await testDataSource.getRepository(UserEntity).update(id, { onboardingCompletedAt: new Date(),
        profileImageKey: 'profiles/image' });
      await withdraw(id).expect(200);
      const pending = await findUser(id);
      const save = sessionStore.save.bind(sessionStore);
      vi.spyOn(sessionStore, 'save').mockImplementationOnce(async (session) => {
        // This independent connection only sees committed restoration data.
        expect((await findUser(id)).status).toBe(UserStatus.ACTIVE);
        expect((await outbox()).filter((event) => event.eventType === 'USER_RESTORED')).toHaveLength(1);
        await save(session);
      });
      const response = await login().set('x-request-id', 'restore-request');
      expect(response.body).toMatchObject({ userId: id, isNewUser: false,
        onboardingRequired: false, restoredFromWithdrawal: true });
      const restored = await findUser(id);
      expect(restored).toEqual({ ...pending, status: UserStatus.ACTIVE,
        withdrawalRequestedAt: null, withdrawalDeadlineAt: null, updatedAt: expect.any(Date) });
      const events = await outbox();
      expect(events).toHaveLength(2);
      expectEnvelope(events.find((event) => event.eventType === 'USER_RESTORED')!,
        id, 'USER_RESTORED', 'restore-request', { userId: id, status: 'ACTIVE' });
      const sid = parseRefreshToken(response.body.refreshToken as string)!;
      expect(await sessionStore.find(sid)).toMatchObject({ userId: id,
        refreshTokenHash: hashRefreshToken(response.body.refreshToken as string) });
      expect(await redis.smembers(RedisSessionStore.userSessionsKey(id))).toEqual([sid]);
      await refresh(original.body.refreshToken as string).expect(401);
      await refresh(response.body.refreshToken as string).expect(200);
      expect((await login()).body.restoredFromWithdrawal).toBe(false);
      expect(await outbox()).toHaveLength(2);
    });

    it('serializes concurrent Kakao restores into one transition and one event', async () => {
      const user = await insertAccount();
      await withdraw(user.id).expect(200);
      const responses = await Promise.all([login(), login()]);
      expect(responses.map((response) => response.body.restoredFromWithdrawal).sort()).toEqual([false, true]);
      expect((await findUser(user.id)).status).toBe(UserStatus.ACTIVE);
      const restored = (await outbox()).filter((event) => event.eventType === 'USER_RESTORED');
      expect(restored).toHaveLength(1);
      expectEnvelope(restored[0]!, user.id, 'USER_RESTORED', undefined, { userId: user.id, status: 'ACTIVE' });
      expect(await redis.scard(RedisSessionStore.userSessionsKey(user.id))).toBe(2);
    });

    it.each(['expired', 'missing', 'withdrawn'] as const)('rejects %s recovery without inline finalization', async (mode) => {
      const user = await insertAccount();
      await withdraw(user.id).expect(200);
      await testDataSource.getRepository(UserEntity).update(user.id, {
        status: mode === 'withdrawn' ? UserStatus.WITHDRAWN : UserStatus.WITHDRAWAL_PENDING,
        withdrawalDeadlineAt: mode === 'missing' ? null : new Date(Date.now() - 1000),
      });
      const before = await findUser(user.id);
      const events = await outbox();
      const response = await request(app.getHttpServer()).post('/api/v1/auth/kakao')
        .send({ authorizationCode: 'code' }).expect(401);
      expect(response.body).not.toHaveProperty('accessToken');
      expect(await findUser(user.id)).toEqual(before);
      expect(await outbox()).toEqual(events);
      expect(await redis.exists(RedisSessionStore.userSessionsKey(user.id))).toBe(0);
    });

    it('keeps committed restoration if session creation fails, and allows a fresh login retry', async () => {
      const user = await insertAccount();
      await withdraw(user.id).expect(200);
      vi.spyOn(sessionStore, 'save').mockRejectedValueOnce(new Error('Redis unavailable'));
      const response = await request(app.getHttpServer()).post('/api/v1/auth/kakao')
        .send({ authorizationCode: 'code' }).expect(503);
      expect(response.body).not.toHaveProperty('accessToken');
      expect((await findUser(user.id)).status).toBe(UserStatus.ACTIVE);
      expect((await outbox()).filter((event) => event.eventType === 'USER_RESTORED')).toHaveLength(1);
      expect((await login()).body.restoredFromWithdrawal).toBe(false);
      expect(await outbox()).toHaveLength(2);
    });

    it.each([UserStatus.WITHDRAWAL_PENDING, UserStatus.WITHDRAWN, UserStatus.SUSPENDED])(
      'rejects stale refresh sessions for %s before signing or rotating', async (status) => {
        const response = await login();
        const id = response.body.userId as string;
        const token = response.body.refreshToken as string;
        await testDataSource.getRepository(UserEntity).update(id, { status });
        const before = await sessionStore.find(parseRefreshToken(token)!);
        const sign = vi.spyOn(app.get(AccessTokenService), 'create');
        const rotate = vi.spyOn(sessionStore, 'rotate');
        const failed = await refresh(token).expect(401);
        expect(failed.body).not.toHaveProperty('accessToken');
        expect(sign).not.toHaveBeenCalled();
        expect(rotate).not.toHaveBeenCalled();
        expect(await sessionStore.find(parseRefreshToken(token)!)).toEqual(before);
      },
    );

    it('rejects a stale session whose user no longer exists', async () => {
      const response = await login();
      await testDataSource.getRepository(OAuthAccountEntity).delete({ userId: response.body.userId as string });
      await testDataSource.getRepository(UserEntity).delete(response.body.userId as string);
      await refresh(response.body.refreshToken as string).expect(401);
    });

    it('rejects refresh that read a valid session before withdrawal committed', async () => {
      const response = await login();
      const token = response.body.refreshToken as string;
      const find = sessionStore.find.bind(sessionStore);
      let snapshotRead!: () => void;
      let resume!: () => void;
      const snapshotReady = new Promise<void>((resolve) => { snapshotRead = resolve; });
      const resumed = new Promise<void>((resolve) => { resume = resolve; });
      vi.spyOn(sessionStore, 'find').mockImplementationOnce(async (sid) => {
        const snapshot = await find(sid);
        snapshotRead();
        await resumed;
        return snapshot;
      });
      const refreshing = refresh(token).then((result) => result);
      await snapshotReady;
      try {
        await withdraw(response.body.userId as string).expect(200);
      } finally {
        resume();
      }
      expect((await refreshing).status).toBe(401);
      expect(await find(parseRefreshToken(token)!)).toBeNull();
    });

    it('serializes an in-flight login session save with withdrawal cleanup', async () => {
      const user = await insertAccount();
      const save = sessionStore.save.bind(sessionStore);
      let saving!: () => void;
      let resume!: () => void;
      const saveStarted = new Promise<void>((resolve) => { saving = resolve; });
      const resumed = new Promise<void>((resolve) => { resume = resolve; });
      vi.spyOn(sessionStore, 'save').mockImplementationOnce(async (session) => {
        saving();
        await resumed;
        await save(session);
      });
      const loggingIn = login().then((result) => result);
      await saveStarted;
      const withdrawing = withdraw(user.id).then((result) => result);
      resume();
      const [loggedIn, withdrawn] = await Promise.all([loggingIn, withdrawing]);
      expect(withdrawn.status).toBe(200);
      expect((await findUser(user.id)).status).toBe(UserStatus.WITHDRAWAL_PENDING);
      expect(await sessionStore.find(parseRefreshToken(loggedIn.body.refreshToken as string)!)).toBeNull();
      expect(await redis.exists(RedisSessionStore.userSessionsKey(user.id))).toBe(0);
    });

    it.each(['withdrawal', 'restore'] as const)('rolls back %s when Outbox INSERT fails', async (operation) => {
      const response = await login();
      const id = response.body.userId as string;
      if (operation === 'restore') await withdraw(id).expect(200);
      const before = await findUser(id);
      const events = await outbox();
      const sessions = await redis.smembers(RedisSessionStore.userSessionsKey(id));
      // Failure injection affects only this suite's temporary PostgreSQL database.
      await testDataSource.query('ALTER TABLE outbox_events ADD CONSTRAINT test_reject_event CHECK (false) NOT VALID');
      try {
        if (operation === 'withdrawal') await withdraw(id).expect(500);
        else await request(app.getHttpServer()).post('/api/v1/auth/kakao')
          .send({ authorizationCode: 'code' }).expect(500);
        expect(await findUser(id)).toEqual(before);
        expect(await outbox()).toEqual(events);
        expect(await redis.smembers(RedisSessionStore.userSessionsKey(id))).toEqual(sessions);
      } finally {
        await testDataSource.query('ALTER TABLE outbox_events DROP CONSTRAINT test_reject_event');
      }
    });

    it.each(['withdrawal', 'restore'] as const)('rolls back %s even when DB commit fails', async (operation) => {
      const response = await login();
      const id = response.body.userId as string;
      if (operation === 'restore') await withdraw(id).expect(200);
      const before = await findUser(id);
      const events = await outbox();
      await testDataSource.query(`CREATE FUNCTION test_reject_commit() RETURNS trigger LANGUAGE plpgsql AS $$
        BEGIN RAISE EXCEPTION 'Injected commit failure'; END $$`);
      await testDataSource.query(`CREATE CONSTRAINT TRIGGER test_reject_commit
        AFTER INSERT ON outbox_events DEFERRABLE INITIALLY DEFERRED
        FOR EACH ROW EXECUTE FUNCTION test_reject_commit()`);
      try {
        if (operation === 'withdrawal') await withdraw(id).expect(500);
        else await request(app.getHttpServer()).post('/api/v1/auth/kakao')
          .send({ authorizationCode: 'code' }).expect(500);
        expect(await findUser(id)).toEqual(before);
        expect(await outbox()).toEqual(events);
        // Cleanup is irreversible if PostgreSQL commit fails after Redis succeeds.
        expect(await sessionStore.find(parseRefreshToken(response.body.refreshToken as string)!)).toBeNull();
        expect(await redis.exists(RedisSessionStore.userSessionsKey(id))).toBe(0);
      } finally {
        await testDataSource.query('DROP TRIGGER test_reject_commit ON outbox_events');
        await testDataSource.query('DROP FUNCTION test_reject_commit()');
      }
    });

    function withdraw(userId: string): request.Test {
      return request(app.getHttpServer()).post('/api/v1/users/me/withdrawal').set('x-user-id', userId);
    }

    function findUser(id: string): Promise<UserEntity> {
      return testDataSource.getRepository(UserEntity).findOneByOrFail({ id });
    }

    function outbox(): Promise<OutboxEventEntity[]> {
      return testDataSource.getRepository(OutboxEventEntity).find({ order: { createdAt: 'ASC' } });
    }

    function expectEnvelope(
      event: OutboxEventEntity, userId: string, eventType: string,
      correlationId: string | undefined, payload: Record<string, unknown>,
    ): void {
      const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
      expect(event.eventId).toMatch(uuid);
      expect(event).toMatchObject({ aggregateId: userId, eventType,
        status: 'PENDING', publishAttempts: 0, publishedAt: null });
      expect(event.payload).toEqual({
        eventId: event.eventId, type: event.eventType, producer: 'user-service',
        correlationId: correlationId ?? expect.stringMatching(uuid),
        target: { type: 'USER', id: event.aggregateId },
        occurredAt: event.createdAt.toISOString(), version: 1, payload,
      });
      expect(new Date(event.payload.occurredAt as string).toISOString()).toBe(event.payload.occurredAt);
    }
  });

  function refresh(refreshToken: string): request.Test {
    return request(app.getHttpServer()).post('/api/v1/auth/refresh').send({ refreshToken });
  }

  function logout(userId: string, sessionId: string): request.Test {
    return request(app.getHttpServer()).post('/api/v1/auth/logout')
      .set('x-user-id', userId).set('x-session-id', sessionId);
  }

  async function insertAccount(
    overrides: {
      onboardingCompletedAt?: Date;
      status?: UserStatus;
    } = {},
  ): Promise<UserEntity> {
    const now = new Date();
    const user = testDataSource.getRepository(UserEntity).create({
      id: randomUUID(),
      nickname: `existing_${randomUUID().slice(0, 8)}`,
      profileImageKey: null,
      status: overrides.status ?? UserStatus.ACTIVE,
      suspendedUntil: null,
      withdrawalRequestedAt: null,
      withdrawalDeadlineAt: null,
      withdrawnAt: null,
      onboardingCompletedAt: overrides.onboardingCompletedAt ?? null,
      createdAt: now,
      updatedAt: now,
    });
    await testDataSource.getRepository(UserEntity).save(user);
    await testDataSource.getRepository(OAuthAccountEntity).save({
      id: randomUUID(),
      userId: user.id,
      provider: 'KAKAO',
      providerUserId: '12345678901234567890',
      providerEmail: null,
      createdAt: now,
      updatedAt: now,
    });
    return user;
  }
});
