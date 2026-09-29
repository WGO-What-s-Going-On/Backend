import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, SelectQueryBuilder, type Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxEventEntity } from '../src/database/entities/outbox-event.entity.js';
import { TermEntity } from '../src/database/entities/term.entity.js';
import { UserTermConsentEntity } from '../src/database/entities/user-term-consent.entity.js';
import { BadgeEntity } from '../src/database/entities/badge.entity.js';
import { UserBadgeEntity } from '../src/database/entities/user-badge.entity.js';

import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { UserEntity, UserStatus } from '../src/database/entities/user.entity.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from '../src/database/migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';
import { RedisSessionStore } from '../src/auth/redis-session.store.js';

const testDatabaseName = `wgo_users_test_${process.pid}_${Date.now()}`;

describe('Users API integration', () => {
  let adminDataSource: DataSource;
  let testDataSource: DataSource;
  let usersRepository: Repository<UserEntity>;
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
    usersRepository = testDataSource.getRepository(UserEntity);

    const module = await Test.createTestingModule({
      controllers: [UsersController],
      providers: [
        UsersService,
        // Withdrawal uses the real Redis store in auth.integration.test.ts.
        { provide: RedisSessionStore, useValue: {} },
        {
          provide: getRepositoryToken(UserEntity),
          useValue: usersRepository,
        },
      ],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  }, 30_000);

  afterAll(async () => {
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
    await testDataSource.query('TRUNCATE TABLE "users" CASCADE');
    await testDataSource.query('TRUNCATE TABLE "outbox_events"');
  });

  it('returns available when the nickname does not exist', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .query({ nickname: 'NewNickname' })
      .expect(200)
      .expect({ available: true, reason: null });
  });

  it('returns DUPLICATED for an exact nickname match', async () => {
    await insertUser('DaeJun');

    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .query({ nickname: 'DaeJun' })
      .expect(200)
      .expect({ available: false, reason: 'DUPLICATED' });
  });

  it('returns DUPLICATED for a case-insensitive nickname match', async () => {
    await insertUser('DaeJun');

    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .query({ nickname: 'daejun' })
      .expect(200)
      .expect({ available: false, reason: 'DUPLICATED' });
  });

  it('trims the nickname before checking duplication', async () => {
    await insertUser('DaeJun');

    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .query({ nickname: '  DAEJUN  ' })
      .expect(200)
      .expect({ available: false, reason: 'DUPLICATED' });
  });

  it('rejects a missing nickname', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .expect(400);
  });

  it('rejects an empty nickname after trimming', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .query({ nickname: '   ' })
      .expect(400);
  });

  it('rejects a nickname longer than 30 characters', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users/nickname/availability')
      .query({ nickname: 'a'.repeat(31) })
      .expect(400);
  });

  it('returns only the public profile and derives onboarding status', async () => {
    const id = await insertUser('Temporary');
    const user = await usersRepository.findOneByOrFail({ id });
    await request(app.getHttpServer()).get('/api/v1/users/me').set('x-user-id', id)
      .expect(200).expect({ userId: id, nickname: 'Temporary', profileImageKey: null,
        status: 'ACTIVE', onboardingRequired: true, createdAt: user.createdAt.toISOString() });
    await usersRepository.update(id, { onboardingCompletedAt: new Date() });
    const response = await request(app.getHttpServer()).get('/api/v1/users/me').set('x-user-id', id).expect(200);
    expect(response.body.onboardingRequired).toBe(false);
  });

  it('requires context and returns 404 for unknown users', async () => {
    for (const method of ['get', 'patch'] as const) {
      await request(app.getHttpServer())[method]('/api/v1/users/me').send({ nickname: 'Valid' }).expect(401);
      await request(app.getHttpServer())[method]('/api/v1/users/me').set('x-user-id', 'invalid')
        .send({ nickname: 'Valid' }).expect(401);
      await request(app.getHttpServer())[method]('/api/v1/users/me').set('x-user-id', crypto.randomUUID())
        .send({ nickname: 'Valid' }).expect(404);
    }
  });

  it('completes onboarding and writes exactly one complete USER_CREATED envelope', async () => {
    const id = await insertUser('Temporary');
    const response = await patch(id, { nickname: '  FinalName  ', profileImageKey: 'profiles/image' })
      .set('x-request-id', 'onboarding-request').expect(200);
    expect(response.body).toMatchObject({ nickname: 'FinalName', profileImageKey: 'profiles/image', onboardingRequired: false });
    const user = await usersRepository.findOneByOrFail({ id });
    expect(user.onboardingCompletedAt).toBeInstanceOf(Date);
    const events = await outbox();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({ aggregateId: id, eventType: 'USER_CREATED', status: 'PENDING', publishAttempts: 0, publishedAt: null });
    expect(event.payload).toEqual({ eventId: event.eventId, type: 'USER_CREATED', target: { type: 'USER', id },
      occurredAt: event.createdAt.toISOString(), version: 1,
      producer: 'user-service', correlationId: 'onboarding-request',
      payload: { userId: id, nickname: 'FinalName', profileImageKey: 'profiles/image' } });
  });

  it('keeps image-only updates in onboarding without events', async () => {
    const id = await insertUser('Temporary');
    const response = await patch(id, { profileImageKey: 'profiles/image' }).expect(200);
    expect(response.body.onboardingRequired).toBe(true);
    expect((await usersRepository.findOneByOrFail({ id })).onboardingCompletedAt).toBeNull();
    expect(await outbox()).toHaveLength(0);
  });

  it.each([{ nickname: 'Changed' }, { profileImageKey: 'profiles/image' },
    { nickname: 'Changed', profileImageKey: 'profiles/image' }])('creates one profile update for %j', async (input) => {
    const id = await insertUser('Original');
    await usersRepository.update(id, { onboardingCompletedAt: new Date() });
    await patch(id, input).expect(200);
    const events = await outbox();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({
      aggregateId: id,
      eventType: 'USER_PROFILE_UPDATED',
      status: 'PENDING',
      publishAttempts: 0,
      publishedAt: null,
    });
    expect(event.payload).toEqual({
      eventId: event.eventId,
      type: event.eventType,
      target: { type: 'USER', id: event.aggregateId },
      occurredAt: event.createdAt.toISOString(),
      version: 1,
      producer: 'user-service',
      correlationId: expect.stringMatching(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
      payload: {
        userId: id,
        nickname: input.nickname ?? 'Original',
        profileImageKey: input.profileImageKey ?? null,
      },
    });
    expect(event.payload.occurredAt).toEqual(expect.any(String));
    expect(event.payload.occurredAt).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
    expect(new Date(event.payload.occurredAt as string).toISOString()).toBe(event.payload.occurredAt);
    await patch(id, input).expect(200);
    expect(await outbox()).toHaveLength(1);
  });

  it('accepts self nickname, case changes and explicit image removal', async () => {
    const id = await insertUser('DaeJun');
    await patch(id, { nickname: 'DaeJun' }).expect(200);
    await patch(id, { nickname: '  DaeJun  ', profileImageKey: null }).expect(200);
    expect(await outbox()).toHaveLength(1);
    await patch(id, { nickname: 'DAEJUN', profileImageKey: 'image' }).expect(200);
    await patch(id, { profileImageKey: null }).expect(200);
    expect((await usersRepository.findOneByOrFail({ id })).profileImageKey).toBeNull();
    expect(await outbox()).toHaveLength(3);
  });

  it('rejects other users case-insensitive nicknames', async () => {
    await insertUser('DaeJun');
    const id = await insertUser('Other');
    await patch(id, { nickname: '  DAEJUN  ' }).expect(409);
    expect(await outbox()).toHaveLength(0);
  });

  it('maps the actual DB unique constraint to 409 after a stale precheck', async () => {
    await insertUser('DaeJun');
    const id = await insertUser('Other');
    vi.spyOn(SelectQueryBuilder.prototype, 'getExists').mockResolvedValue(false);
    await patch(id, { nickname: 'DAEJUN' }).expect(409);
    expect((await usersRepository.findOneByOrFail({ id })).nickname).toBe('Other');
    expect(await outbox()).toHaveLength(0);
  });

  it.each([{}, { nickname: '' }, { nickname: '  ' }, { nickname: 'a'.repeat(31) },
    { nickname: null }, { nickname: 1 }, { profileImageKey: 1 },
    { profileImageKey: 'a'.repeat(501) }, { status: 'ACTIVE' }])('rejects invalid PATCH %j', async (input) => {
    const id = await insertUser('Original');
    await patch(id, input).expect(400);
    expect(await outbox()).toHaveLength(0);
  });

  it('serializes concurrent onboarding patches into one USER_CREATED', async () => {
    const id = await insertUser('Temporary');
    await Promise.all([patch(id, { nickname: 'First' }).expect(200), patch(id, { nickname: 'Second' }).expect(200)]);
    const events = await outbox();
    expect(events.filter((event) => event.eventType === 'USER_CREATED')).toHaveLength(1);
    expect(events.filter((event) => event.eventType === 'USER_PROFILE_UPDATED')).toHaveLength(1);
  });

  it('rolls back the profile update when Outbox INSERT fails', async () => {
    const id = await insertUser('Temporary');
    const before = await usersRepository.findOneByOrFail({ id });
    // Failure injection is restricted to this test run's temporary database.
    await testDataSource.query('ALTER TABLE outbox_events ADD CONSTRAINT test_reject_event CHECK (false)');
    try {
      await patch(id, { nickname: 'FinalName' }).expect(500);
      expect(await usersRepository.findOneByOrFail({ id })).toEqual(before);
      expect(await outbox()).toHaveLength(0);
    } finally {
      await testDataSource.query('ALTER TABLE outbox_events DROP CONSTRAINT test_reject_event');
    }
  });

  function patch(id: string, body: object): request.Test {
    return request(app.getHttpServer()).patch('/api/v1/users/me').set('x-user-id', id).send(body);
  }

  describe('term consents and badges', () => {
    beforeEach(async () => {
      await testDataSource.query('TRUNCATE TABLE "terms", "badges" RESTART IDENTITY CASCADE');
    });

    it('saves all required and optional consents without changing the user or creating events', async () => {
      const id = await insertUser('Consenting');
      const before = await usersRepository.findOneByOrFail({ id });
      await seedTerms();
      const startedAt = Date.now();
      await consent(id, [1, 2, 3]).expect(200).expect({ termIds: ['1', '2', '3'] });
      const rows = await consentRows(id);
      expect(rows).toHaveLength(3);
      expect(rows.map((row) => row.termId)).toEqual(['1', '2', '3']);
      for (const row of rows) {
        expect(row.userId).toBe(id);
        expect(row.revokedAt).toBeNull();
        expect(row.agreedAt.getTime()).toBeGreaterThanOrEqual(startedAt);
        expect(row.agreedAt.getTime()).toBeLessThanOrEqual(Date.now());
      }
      expect(await usersRepository.findOneByOrFail({ id })).toEqual(before);
      expect(await outbox()).toHaveLength(0);
    });

    it('preserves active agreement times on repeated and duplicate input', async () => {
      const id = await insertUser('Consenting');
      await seedTerms();
      await consent(id, [1, '1', '01', 2, 2]).expect(200).expect({ termIds: ['1', '2'] });
      const earlier = new Date('2025-01-01T00:00:00Z');
      await testDataSource.getRepository(UserTermConsentEntity).update({ userId: id }, { agreedAt: earlier });
      const before = await consentRows(id);
      await consent(id, [1, 2]).expect(200);
      expect(await consentRows(id)).toEqual(before);
    });

    it('serializes concurrent identical consent submissions', async () => {
      const id = await insertUser('Consenting');
      await seedTerms();
      await Promise.all([consent(id, [1, 2]).expect(200), consent(id, [1, 2]).expect(200)]);
      expect(await consentRows(id)).toHaveLength(2);
    });

    it('reactivates a revoked consent without creating another row', async () => {
      const id = await insertUser('Consenting');
      await seedTerms();
      await consent(id, [1, 2]).expect(200);
      const repository = testDataSource.getRepository(UserTermConsentEntity);
      await repository.update({ userId: id, termId: '1' }, {
        agreedAt: new Date('2025-01-01T00:00:00Z'), revokedAt: new Date('2025-01-02T00:00:00Z'),
      });
      const before = await consentRows(id);
      await consent(id, [1, 2]).expect(200);
      const after = await consentRows(id);
      expect(after).toHaveLength(2);
      expect(after[0]!.id).toBe(before[0]!.id);
      expect(after[0]!.revokedAt).toBeNull();
      expect(after[0]!.agreedAt.getTime()).toBeGreaterThan(before[0]!.agreedAt.getTime());
      expect(after[1]).toEqual(before[1]);
    });

    it.each([[1, 2, 999], [1], [2, 3], [1, 2, 4], [2, 4], [1, 2, 5]])(
      'rejects nonexistent, missing-required, old or future terms: %j', async (...ids) => {
        const id = await insertUser('Consenting');
        await seedTerms();
        await consent(id, ids).expect(400);
        expect(await consentRows(id)).toHaveLength(0);
      },
    );

    it('uses effective date rather than version text, and highest ID to break date ties', async () => {
      const id = await insertUser('Consenting');
      await seedTerms();
      const terms = testDataSource.getRepository(TermEntity);
      const current = await terms.findOneByOrFail({ id: '1' });
      await terms.insert({ ...current, id: '6', version: '0.1' });
      await consent(id, [1, 2]).expect(400);
      await consent(id, [6, 2]).expect(200);
      expect((await consentRows(id)).map((row) => row.termId)).toEqual(['2', '6']);
    });

    it('derives required flags from current versions only and preserves large term IDs', async () => {
      const id = await insertUser('Consenting');
      await seedTerms();
      const terms = testDataSource.getRepository(TermEntity);
      await terms.update('1', { required: false });
      await terms.insert({ id: '9007199254740993', code: 'EXTRA', version: '1', required: false,
        documentUrl: 'https://example.test/extra', effectiveAt: new Date(Date.now() - 1000), createdAt: new Date() });
      await consent(id, [2, '9007199254740993']).expect(200)
        .expect({ termIds: ['2', '9007199254740993'] });
      expect((await consentRows(id)).map((row) => row.termId)).toEqual(['2', '9007199254740993']);
    });

    it.each([{}, { termIds: [] }, { termIds: null }, { termIds: '1' },
      { termIds: [0] }, { termIds: [-1] }, { termIds: [1.5] }, { termIds: [true] },
      { termIds: [null] }, { termIds: ['1x'] }, { termIds: [9007199254740992] },
      { termIds: ['9223372036854775808'] }])('rejects invalid consent body %j', async (body) => {
      const id = await insertUser('Consenting');
      await request(app.getHttpServer()).post('/api/v1/users/me/term-consents')
        .set('x-user-id', id).send(body).expect(400);
    });

    it('requires auth context and an existing user for both endpoints', async () => {
      for (const [method, path] of [['post', 'term-consents'], ['get', 'badges']] as const) {
        await request(app.getHttpServer())[method](`/api/v1/users/me/${path}`).send({ termIds: [1] }).expect(401);
        await request(app.getHttpServer())[method](`/api/v1/users/me/${path}`)
          .set('x-user-id', 'invalid').send({ termIds: [1] }).expect(401);
        await request(app.getHttpServer())[method](`/api/v1/users/me/${path}`)
          .set('x-user-id', crypto.randomUUID()).send({ termIds: [1] }).expect(404);
      }
    });

    it('lists only active, unrevoked badges belonging to the current user, newest first', async () => {
      const id = await insertUser('BadgeOwner');
      const other = await insertUser('OtherOwner');
      const old = new Date('2026-01-01T00:00:00Z');
      const recent = new Date('2026-02-01T00:00:00Z');
      const badges = testDataSource.getRepository(BadgeEntity);
      await badges.insert(['1', '2', '3', '4', '5', '9007199254740993'].map((badgeId) => ({
        id: badgeId, code: `BADGE_${badgeId}`, name: `Badge ${badgeId}`,
        description: badgeId === '1' ? null : 'Description', imageKey: badgeId === '1' ? null : 'badges/image',
        active: badgeId !== '4', createdAt: old,
      })));
      await testDataSource.getRepository(UserBadgeEntity).insert([
        { userId: id, badgeId: '1', grantedAt: old, revokedAt: null },
        { userId: id, badgeId: '2', grantedAt: recent, revokedAt: null },
        { userId: id, badgeId: '9007199254740993', grantedAt: recent, revokedAt: null },
        { userId: id, badgeId: '3', grantedAt: recent, revokedAt: recent },
        { userId: id, badgeId: '4', grantedAt: recent, revokedAt: null },
        { userId: other, badgeId: '5', grantedAt: recent, revokedAt: null },
      ]);
      const response = await request(app.getHttpServer()).get('/api/v1/users/me/badges')
        .set('x-user-id', id).expect(200);
      expect(response.body).toEqual({ badges: [
        { badgeId: '9007199254740993', code: 'BADGE_9007199254740993', name: 'Badge 9007199254740993',
          description: 'Description', imageKey: 'badges/image', grantedAt: recent.toISOString() },
        { badgeId: '2', code: 'BADGE_2', name: 'Badge 2', description: 'Description',
          imageKey: 'badges/image', grantedAt: recent.toISOString() },
        { badgeId: '1', code: 'BADGE_1', name: 'Badge 1', description: null, imageKey: null, grantedAt: old.toISOString() },
      ] });
      expect(await outbox()).toHaveLength(0);
    });

    it('returns an empty badge array when the user has no badges', async () => {
      const id = await insertUser('NoBadges');
      await request(app.getHttpServer()).get('/api/v1/users/me/badges')
        .set('x-user-id', id).expect(200).expect({ badges: [] });
    });

    function consent(id: string, termIds: (string | number)[]): request.Test {
      return request(app.getHttpServer()).post('/api/v1/users/me/term-consents')
        .set('x-user-id', id).send({ termIds });
    }

    function consentRows(userId: string): Promise<UserTermConsentEntity[]> {
      return testDataSource.getRepository(UserTermConsentEntity).find({ where: { userId }, order: { termId: 'ASC' } });
    }

    async function seedTerms(): Promise<void> {
      const now = new Date();
      await testDataSource.getRepository(TermEntity).insert([
        { id: '1', code: 'SERVICE', version: '1.0', required: true, effectiveAt: new Date(Date.now() - 60_000) },
        { id: '2', code: 'PRIVACY', version: '1.0', required: true, effectiveAt: new Date(Date.now() - 60_000) },
        { id: '3', code: 'LOCATION', version: '1.0', required: false, effectiveAt: new Date(Date.now() - 60_000) },
        { id: '4', code: 'SERVICE', version: '99.0', required: true, effectiveAt: new Date(Date.now() - 120_000) },
        { id: '5', code: 'SERVICE', version: '2.0', required: true, effectiveAt: new Date(Date.now() + 86_400_000) },
      ].map((term) => ({ ...term, documentUrl: 'https://example.test/terms', createdAt: now })));
    }
  });

  function outbox(): Promise<OutboxEventEntity[]> {
    return testDataSource.getRepository(OutboxEventEntity).find();
  }

  async function insertUser(nickname: string): Promise<string> {
    const now = new Date();
    const id = crypto.randomUUID();
    await usersRepository.insert({
      id,
      nickname,
      status: UserStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    });
    return id;
  }
});
