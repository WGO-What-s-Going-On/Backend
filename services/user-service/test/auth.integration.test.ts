import { UnauthorizedException, type INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Test } from '@nestjs/testing';
import { getDataSourceToken } from '@nestjs/typeorm';
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
      controllers: [AuthController],
      providers: [
        AuthService,
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
      expiresIn: accessTtlSeconds,
    });
    expect(response.body.userId).toEqual(expect.any(String));
    expect(response.body.accessToken).toEqual(expect.any(String));
    expect(response.body.refreshToken).toEqual(expect.any(String));
    expect(Object.keys(response.body).sort()).toEqual([
      'accessToken', 'expiresIn', 'isNewUser', 'onboardingRequired', 'refreshToken', 'userId',
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
