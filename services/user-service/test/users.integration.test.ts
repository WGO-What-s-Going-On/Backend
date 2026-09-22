import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, SelectQueryBuilder, type Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { OutboxEventEntity } from '../src/database/entities/outbox-event.entity.js';

import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { UserEntity, UserStatus } from '../src/database/entities/user.entity.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from '../src/database/migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';

const testDatabaseName = `wgo_users_test_${process.pid}_${Date.now()}`;

describe('GET /api/v1/users/nickname/availability', () => {
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
    const response = await patch(id, { nickname: '  FinalName  ', profileImageKey: 'profiles/image' }).expect(200);
    expect(response.body).toMatchObject({ nickname: 'FinalName', profileImageKey: 'profiles/image', onboardingRequired: false });
    const user = await usersRepository.findOneByOrFail({ id });
    expect(user.onboardingCompletedAt).toBeInstanceOf(Date);
    const events = await outbox();
    expect(events).toHaveLength(1);
    const event = events[0]!;
    expect(event).toMatchObject({ aggregateId: id, eventType: 'USER_CREATED', status: 'PENDING', publishAttempts: 0, publishedAt: null });
    expect(event.payload).toEqual({ eventId: event.eventId, type: 'USER_CREATED', target: { type: 'USER', id },
      occurredAt: event.createdAt.toISOString(), version: 1,
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
