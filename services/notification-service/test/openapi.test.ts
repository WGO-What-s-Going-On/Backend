import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { configureSwagger } from '../src/swagger.js';
import { NOTIFICATION_REPOSITORY } from '../src/notification/notification.repository.js';
import { PUSH_SUBSCRIPTION_REPOSITORY } from '../src/push-subscription/push-subscription.repository.js';
import { NotificationState } from '../src/redis/notification-state.js';
import { PostgresEventStore } from '../src/persistence/postgres-event.store.js';
import { NearbySubscriptionService } from '../src/notification/nearby-subscription.service.js';
import { NotificationStreamWorkers } from '../src/event-consumer/notification-stream.workers.js';
import { PostEventConsumer } from '../src/event-consumer/post-event.consumer.js';
import { PostEventHandler } from '../src/event-consumer/post-event.handler.js';
import { NearbyWorker } from '../src/notification/nearby.worker.js';
import type { Notification } from '../src/notification/notification.js';

const notification: Notification = {
  notificationId: '2026-11-04T00:00:00.000Z_example',
  userId: '123',
  type: 'COMMENT_CREATED',
  title: 'Reply',
  body: 'New reply',
  actorId: '456',
  targetType: 'post',
  targetId: 'post_00000000-0000-0000-0000-000000000001',
  actionPath: '/posts/post_00000000-0000-0000-0000-000000000001',
  count: 1,
  isRead: false,
  createdAt: '2026-11-04T00:00:00.000Z',
  expiresAt: 1796342400,
  commentId: 'comment_example',
  metadata: { example: true },
};

describe('Notification OpenAPI contract', () => {
  let app: INestApplication;
  let doc: any;
  beforeAll(async () => {
    // Keep real controllers/services and Swagger discovery without starting workers or external stores.
    const builder = Test.createTestingModule({
      imports: [AppModule],
    });
    for (const provider of [
      NotificationStreamWorkers,
      PostEventConsumer,
      PostEventHandler,
      NearbyWorker,
    ])
      builder.overrideProvider(provider).useValue({});
    builder.overrideProvider(NOTIFICATION_REPOSITORY).useValue({
      list: async () => ({ items: [notification] }),
      markRead: async (_user: string, id: string) =>
        id === notification.notificationId
          ? { ...notification, isRead: true }
          : null,
      countUnread: async () => 1,
      remove: async () => undefined,
    });
    builder.overrideProvider(NotificationState).useValue({
      unread: async () => 1,
      decrementUnread: async () => undefined,
      invalidateUnread: async () => undefined,
    });
    builder.overrideProvider(PUSH_SUBSCRIPTION_REPOSITORY).useValue({
      list: async () => [],
      upsert: async (input: unknown) => input,
      remove: async () => undefined,
    });
    const preferences = {
      nearby: true,
      replies: true,
      reactions: true,
      lifecycle: true,
      rewards: true,
      votes: true,
      moderation: true,
    };
    builder.overrideProvider(PostgresEventStore).useValue({
      preferences: async () => preferences,
      savePreferences: async (_user: string, input: object) => ({
        ...preferences,
        ...input,
      }),
      boardPreference: async (_user: string, postId: string) => ({
        postId,
        enabled: true,
      }),
      setBoardPreference: async (
        _user: string,
        postId: string,
        enabled: boolean,
      ) => ({ postId, enabled }),
    });
    const nearby = {
      featureEnabled: false,
      enabled: false,
      locationConsent: false,
      expiresAt: null,
      radiusM: 150,
    };
    builder.overrideProvider(NearbySubscriptionService).useValue({
      get: async () => nearby,
      save: async () => nearby,
      remove: async () => undefined,
    });
    const module = await builder.compile();
    app = module.createNestApplication();
    app.useLogger(false);
    configureSwagger(app);
    await app.init();
    doc = (
      await request(app.getHttpServer()).get('/docs/openapi.json').expect(200)
    ).body;
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
      '/health/ready': ['get'],
      '/api/v1/notifications': ['get'],
      '/api/v1/notifications/settings': ['get', 'patch'],
      '/api/v1/notifications/nearby-subscription': ['delete', 'get', 'put'],
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
            path === '/api/v1/notifications/{notificationId}' ||
            (method === 'delete' && path.endsWith('nearby-subscription'))
              ? '204'
              : '200'
          ],
        ).toBeDefined();
      }
    }
    expect(
      doc.paths['/health/live'].get.responses['200'].content['application/json']
        .schema.properties.service.enum,
    ).toEqual(['notification-service']);
    expect(doc.components.securitySchemes.GatewayBearer).toMatchObject({
      type: 'http',
      scheme: 'bearer',
    });
    for (const [path, item] of Object.entries(doc.paths) as [string, any][]) {
      for (const operation of Object.values(item) as any[]) {
        if (path.startsWith('/health/')) {
          expect(operation.security).toBeUndefined();
          continue;
        }
        expect(operation.security).toEqual([{ GatewayBearer: [] }]);
        for (const status of ['400', '401', '500']) {
          expect(
            operation.responses[status].content['application/json'].schema
              .required,
          ).toEqual(['statusCode', 'message']);
        }
      }
    }
    expect(
      doc.paths['/api/v1/notifications/unread-count'].get.responses['200']
        .content['application/json'].schema,
    ).toEqual({
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 0, example: 3 } },
    });
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

  const operation = (suffix: string, method: string) =>
    doc.paths[`/api/v1/notifications${suffix}`][method];
  const responseSchema = (suffix: string, method = 'get') =>
    operation(suffix, method).responses['200'].content['application/json']
      .schema;
  it('documents FCM DTOs, platform enum, registration response and empty 200 removal', async () => {
    const put = operation('/push-subscriptions', 'put'),
      del = operation('/push-subscriptions', 'delete');
    for (const [op, name, required] of [
      [put, 'RegisterPushSubscriptionDto', ['token', 'platform']],
      [del, 'DeletePushSubscriptionDto', ['token']],
    ] as const) {
      expect(op.requestBody.required).toBe(true);
      expect(op.requestBody.content['application/json'].schema.$ref).toBe(
        `#/components/schemas/${name}`,
      );
      expect(doc.components.schemas[name].required).toEqual(required);
      expect(doc.components.schemas[name].properties.token.type).toBe('string');
    }
    expect(
      doc.components.schemas.RegisterPushSubscriptionDto.properties.platform
        .enum,
    ).toEqual(['web', 'ios', 'android']);
    for (const platform of ['web', 'ios', 'android']) {
      const { body } = await request(app.getHttpServer())
        .put('/api/v1/notifications/push-subscriptions')
        .set('X-User-Id', '123')
        .send({ token: 'fcm-token', platform })
        .expect(200);
      expect(Object.keys(body).sort()).toEqual(
        responseSchema('/push-subscriptions', 'put').required.toSorted(),
      );
      expect(body.platform).toBe(platform);
    }
    expect(del.responses['200'].content).toBeUndefined();
    expect(del.responses['204']).toBeUndefined();
    expect(
      (
        await request(app.getHttpServer())
          .delete('/api/v1/notifications/push-subscriptions')
          .set('X-User-Id', '123')
          .send({ token: 'fcm-token' })
          .expect(200)
      ).text,
    ).toBe('');
  });

  it('keeps current FCM validation statuses visible in the contract', async () => {
    for (const [body, status] of [
      [{ token: 1, platform: 'web' }, 400],
      [{ token: 'fcm-token', platform: 'other' }, 500],
      [{ token: ' ', platform: 'web' }, 500],
    ] as const) {
      const result = await request(app.getHttpServer())
        .put('/api/v1/notifications/push-subscriptions')
        .set('X-User-Id', '123')
        .send(body)
        .expect(status);
      expect(result.body.statusCode).toBe(status);
      expect(
        operation('/push-subscriptions', 'put').responses[String(status)],
      ).toBeDefined();
    }
  });

  it('documents every notification field and distinct pagination endings', async () => {
    const page = responseSchema(''),
      item = page.properties.items.items;
    expect(Object.keys(item.properties).sort()).toEqual(
      Object.keys(notification).sort(),
    );
    expect(item.required.toSorted()).toEqual(
      Object.keys(notification)
        .filter((key) => !['commentId', 'metadata'].includes(key))
        .sort(),
    );
    for (const key of ['actorId', 'targetType', 'targetId', 'actionPath'])
      expect(item.properties[key].nullable).toBe(true);
    expect(item.properties.metadata).toMatchObject({
      type: 'object',
      additionalProperties: true,
    });
    expect(item.properties.commentId.type).toBe('string');
    expect(item.properties.expiresAt).toMatchObject({
      type: 'integer',
      description: expect.stringContaining('Unix seconds'),
    });
    expect(responseSchema('/{notificationId}/read', 'patch')).toEqual(item);
    expect(
      operation('', 'get').parameters.find((p: any) => p.name === 'limit')
        .schema,
    ).toMatchObject({ minimum: 1, maximum: 100, default: 20 });
    expect(page.required).not.toContain('nextCursor');
    expect(page.properties.nextCursor.nullable).toBeUndefined();
    expect(
      responseSchema('/read-all', 'patch').properties.nextCursor.nullable,
    ).toBe(true);
    expect(
      (
        await request(app.getHttpServer())
          .get('/api/v1/notifications')
          .set('X-User-Id', '123')
          .expect(200)
      ).body,
    ).toEqual({ items: [notification] });
    expect(
      (
        await request(app.getHttpServer())
          .patch('/api/v1/notifications/read-all')
          .set('X-User-Id', '123')
          .expect(200)
      ).body,
    ).toEqual({ processed: 1, nextCursor: null });
    const read = await request(app.getHttpServer())
      .patch(
        `/api/v1/notifications/${encodeURIComponent(notification.notificationId)}/read`,
      )
      .set('X-User-Id', '123')
      .expect(200);
    expect(read.body).toEqual({ ...notification, isRead: true });
    await request(app.getHttpServer())
      .patch('/api/v1/notifications/missing/read')
      .set('X-User-Id', '123')
      .expect(404);
    expect(
      operation('/{notificationId}/read', 'patch').responses['404'],
    ).toBeDefined();
    await request(app.getHttpServer())
      .get('/api/v1/notifications?limit=101')
      .set('X-User-Id', '123')
      .expect(400);
  });

  it('documents partial settings, complete responses and exact board body', async () => {
    const fields = [
      'nearby',
      'replies',
      'reactions',
      'lifecycle',
      'rewards',
      'votes',
      'moderation',
    ];
    expect(responseSchema('/settings').required).toEqual(fields);
    expect(responseSchema('/settings', 'patch')).toEqual(
      responseSchema('/settings'),
    );
    expect(
      doc.components.schemas.NotificationPreferencesPatch.required ?? [],
    ).toEqual([]);
    for (const key of fields)
      expect(
        doc.components.schemas.NotificationPreferencesPatch.properties[key]
          .type,
      ).toBe('boolean');
    expect(
      (
        await request(app.getHttpServer())
          .patch('/api/v1/notifications/settings')
          .set('X-User-Id', '123')
          .send({ replies: false })
          .expect(200)
      ).body,
    ).toMatchObject({ replies: false, nearby: true });
    for (const body of [{}, { unknown: true }, { replies: 'false' }])
      await request(app.getHttpServer())
        .patch('/api/v1/notifications/settings')
        .set('X-User-Id', '123')
        .send(body)
        .expect(400);
    const board = operation('/boards/{postId}', 'put').requestBody.content[
      'application/json'
    ].schema;
    expect(board).toMatchObject({
      required: ['enabled'],
      additionalProperties: false,
      properties: { enabled: { type: 'boolean' } },
    });
    expect(responseSchema('/boards/{postId}', 'put').required).toEqual([
      'postId',
      'enabled',
    ]);
  });

  it('documents nearby opt-in/withdrawal, nullable expiry and feature-disabled error', async () => {
    const nearby = responseSchema('/nearby-subscription');
    expect(nearby.required.toSorted()).toEqual(
      [
        'featureEnabled',
        'enabled',
        'locationConsent',
        'expiresAt',
        'radiusM',
      ].sort(),
    );
    expect(nearby.properties.expiresAt).toMatchObject({
      type: 'string',
      format: 'date-time',
      nullable: true,
    });
    expect(nearby.properties.radiusM.enum).toEqual([150]);
    expect(responseSchema('/nearby-subscription', 'put')).toEqual(nearby);
    const put = operation('/nearby-subscription', 'put'),
      [disable, enable] =
        put.requestBody.content['application/json'].schema.oneOf;
    expect(disable).toMatchObject({
      required: ['enabled'],
      additionalProperties: false,
      properties: { enabled: { enum: [false] } },
    });
    expect(enable.required).toEqual([
      'enabled',
      'locationConsent',
      'latitude',
      'longitude',
      'capturedAt',
    ]);
    expect(enable.properties.expiresInSeconds).toMatchObject({
      minimum: 60,
      maximum: 900,
      default: 900,
    });
    expect(
      put.responses['503'].content['application/json'].schema.properties
        .statusCode.type,
    ).toBe('integer');
    for (const suffix of ['/nearby-subscription', '/{notificationId}'])
      expect(
        operation(suffix, 'delete').responses['204'].content,
      ).toBeUndefined();
  });

  it('documents and preserves production authentication failure', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const result = await request(app.getHttpServer())
        .get('/api/v1/notifications')
        .set('X-User-Id', '123')
        .expect(401);
      expect(result.body.message).toBe('Invalid gateway identity');
    } finally {
      vi.unstubAllEnvs();
    }
  });
});
