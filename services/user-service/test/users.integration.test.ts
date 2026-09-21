import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, type Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest';

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
    await testDataSource.query('TRUNCATE TABLE "users" CASCADE');
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

  async function insertUser(nickname: string): Promise<void> {
    const now = new Date();
    await usersRepository.insert({
      id: crypto.randomUUID(),
      nickname,
      status: UserStatus.ACTIVE,
      createdAt: now,
      updatedAt: now,
    });
  }
});
