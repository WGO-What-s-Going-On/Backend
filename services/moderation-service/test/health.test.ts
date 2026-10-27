import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';

describe('health endpoint', () => {
  let app: INestApplication;

  beforeEach(async () => {
    // Local credentials must not start real consumers during dependency-free health tests.
    vi.stubEnv('REDIS_URL', '');
    vi.stubEnv('OPENAI_API_KEY', '');
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
    vi.unstubAllEnvs();
  });

  it('reports liveness without Redis or OpenAI', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ service: 'moderation-service', status: 'ok' });
    await request(app.getHttpServer()).get('/health/ready').expect(503);
  });
});
