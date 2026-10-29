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
  it('documents health and all implemented notification HTTP operations', async () => {
    await request(app.getHttpServer())
      .get('/docs')
      .expect(200)
      .expect('Content-Type', /html/);
    const { body: doc } = await request(app.getHttpServer())
      .get('/docs/openapi.json')
      .expect(200);
    const operations = {
      '/health/live': ['get'],
      '/api/v1/notifications': ['get'],
      '/api/v1/notifications/settings': ['get', 'patch'],
      '/api/v1/notifications/boards/{postId}': ['get', 'put'],
      '/api/v1/notifications/read-all': ['patch'],
      '/api/v1/notifications/{notificationId}': ['delete'],
      '/api/v1/notifications/unread-count': ['get'],
      '/api/v1/notifications/{notificationId}/read': ['patch'],
      '/api/v1/notifications/push-subscriptions': ['delete', 'put'],
    };
    expect(Object.keys(doc.paths).sort()).toEqual(
      Object.keys(operations).sort(),
    );
    for (const [path, methods] of Object.entries(operations)) {
      expect(Object.keys(doc.paths[path]).sort()).toEqual(methods);
      for (const method of methods) {
        expect(
          doc.paths[path][method].responses[
            path === '/api/v1/notifications/{notificationId}' ? '204' : '200'
          ],
        ).toBeDefined();
      }
    }
    expect(
      doc.paths['/health/live'].get.responses['200'].content['application/json']
        .schema.properties.service.enum,
    ).toEqual(['notification-service']);
    expect(doc.components.securitySchemes ?? {}).toEqual({});
    await request(app.getHttpServer())
      .get('/health/live')
      .expect(200)
      .expect({ service: 'notification-service', status: 'ok' });
    // Missing local user context must fail validation before accessing storage.
    const { body: error } = await request(app.getHttpServer())
      .get('/api/v1/notifications')
      .expect(400);
    expect(error.message).toBe('positive decimal x-user-id is required');
  });
});
