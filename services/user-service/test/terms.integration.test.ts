import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import request from 'supertest';
import { DataSource, type Repository } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { TermEntity } from '../src/database/entities/term.entity.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from '../src/database/migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';
import { TermsController } from '../src/terms/terms.controller.js';
import { TermsService } from '../src/terms/terms.service.js';

const testDatabaseName = `wgo_terms_test_${process.pid}_${Date.now()}`;

describe('GET /api/v1/terms', () => {
  let adminDataSource: DataSource;
  let testDataSource: DataSource;
  let termsRepository: Repository<TermEntity>;
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
    termsRepository = testDataSource.getRepository(TermEntity);

    const module = await Test.createTestingModule({
      controllers: [TermsController],
      providers: [
        TermsService,
        {
          provide: getRepositoryToken(TermEntity),
          useValue: termsRepository,
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
    await testDataSource.query('TRUNCATE TABLE "terms" RESTART IDENTITY CASCADE');
  });

  it('returns an empty list when no terms exist', async () => {
    await request(app.getHttpServer()).get('/api/v1/terms').expect(200).expect({ terms: [] });
  });

  it('returns a currently effective term', async () => {
    const effectiveAt = new Date(Date.now() - 60_000);
    await insertTerm({ code: 'SERVICE', version: '1.0', effectiveAt });

    const response = await request(app.getHttpServer()).get('/api/v1/terms').expect(200);

    expect(response.body).toEqual({
      terms: [
        {
          termId: '1',
          code: 'SERVICE',
          version: '1.0',
          required: true,
          documentUrl: 'https://example.test/service-1.0',
          effectiveAt: effectiveAt.toISOString(),
        },
      ],
    });
  });

  it('selects the latest effective_at instead of the greatest version string', async () => {
    await insertTerm({
      code: 'SERVICE',
      version: '99.0',
      effectiveAt: new Date(Date.now() - 120_000),
    });
    await insertTerm({
      code: 'SERVICE',
      version: '1.0',
      effectiveAt: new Date(Date.now() - 60_000),
    });

    const response = await request(app.getHttpServer()).get('/api/v1/terms').expect(200);

    expect(response.body.terms).toHaveLength(1);
    expect(response.body.terms[0]).toMatchObject({ code: 'SERVICE', version: '1.0' });
  });

  it('excludes a future term', async () => {
    await insertTerm({
      code: 'LOCATION',
      version: '1.0',
      effectiveAt: new Date(Date.now() + 86_400_000),
    });

    await request(app.getHttpServer()).get('/api/v1/terms').expect(200).expect({ terms: [] });
  });

  it('returns one term per code ordered by code', async () => {
    const effectiveAt = new Date(Date.now() - 60_000);
    await insertTerm({ code: 'SERVICE', version: '1.0', effectiveAt });
    await insertTerm({ code: 'LOCATION', version: '1.0', effectiveAt });
    await insertTerm({ code: 'PRIVACY_COLLECTION_USE', version: '1.0', effectiveAt });

    const response = await request(app.getHttpServer()).get('/api/v1/terms').expect(200);

    expect(response.body.terms.map((term: { code: string }) => term.code)).toEqual([
      'LOCATION',
      'PRIVACY_COLLECTION_USE',
      'SERVICE',
    ]);
  });

  it('returns a BIGINT termId as a precision-safe string', async () => {
    await termsRepository.insert({
      id: '9007199254740993',
      code: 'SERVICE',
      version: '1.0',
      required: true,
      documentUrl: 'https://example.test/service-1.0',
      effectiveAt: new Date(Date.now() - 60_000),
      createdAt: new Date(),
    });

    const response = await request(app.getHttpServer()).get('/api/v1/terms').expect(200);

    expect(response.body.terms[0].termId).toBe('9007199254740993');
  });

  async function insertTerm(input: {
    code: string;
    version: string;
    effectiveAt: Date;
  }): Promise<void> {
    await termsRepository.insert({
      ...input,
      required: true,
      documentUrl: `https://example.test/${input.code.toLowerCase()}-${input.version}`,
      createdAt: new Date(),
    });
  }
});
