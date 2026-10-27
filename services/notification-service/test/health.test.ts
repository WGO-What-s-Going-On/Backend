import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, beforeEach, describe, it } from 'vitest';

import { AppModule } from '../src/app.module.js';

describe('health endpoint', () => {
  let app: INestApplication;

  beforeEach(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();

    app = module.createNestApplication();
    await app.init();
  });

  afterEach(async () => {
    await app.close();
  });

  it('reports liveness without Redis or DynamoDB', async () => {
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ service: 'notification-service', status: 'ok' });
  });
});
