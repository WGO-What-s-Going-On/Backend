import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureSwagger } from '../src/swagger.js';

describe('Notification OpenAPI contract', () => {
  let app: INestApplication;
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    configureSwagger(app);
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  it('documents only implemented health, without inventing public notification APIs', async () => {
    await request(app.getHttpServer())
      .get('/docs')
      .expect(200)
      .expect('Content-Type', /html/);
    const { body: doc } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    expect(Object.keys(doc.paths)).toEqual(['/health/live']);
    expect(Object.keys(doc.paths['/health/live'])).toEqual(['get']);
    expect(
      doc.paths['/health/live'].get.responses['200'].content['application/json']
        .schema.properties.service.enum,
    ).toEqual(['notification-service']);
    expect(doc.components.securitySchemes ?? {}).toEqual({});
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ service: 'notification-service', status: 'ok' });
    await request(app.getHttpServer()).get('/api/v1/notifications').expect(404);
  });
});
