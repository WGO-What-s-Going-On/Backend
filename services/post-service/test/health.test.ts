import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { HealthModule } from '../src/health/health.module.js';

describe('health endpoint', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [HealthModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports liveness without a database connection', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ service: 'post-service', status: 'ok' });
  });
});
