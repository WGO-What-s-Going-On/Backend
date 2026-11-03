import { createRequire } from 'node:module';
import { createPrivateKey, createPublicKey, randomUUID } from 'node:crypto';
import { expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  mergeDocuments,
  validateDocument,
  type ApiDocument,
} from '../src/openapi.js';
import { frontendAuth, frontendBearer } from './frontend-auth-fixture.js';

const load = (path: string) =>
  import(
    new URL(
      `../../../services/notification-service/dist/${path}`,
      import.meta.url,
    ).href
  );
it.skipIf(process.env.RUN_NOTIFICATION_GATEWAY_E2E !== '1')(
  'authenticates real Notification APIs and merges settings/nearby Swagger while isolating SQL owners',
  async () => {
    const requireNotification = createRequire(
        new URL(
          '../../../services/notification-service/package.json',
          import.meta.url,
        ),
      ),
      { Test } = requireNotification('@nestjs/testing'),
      { ConfigService } = requireNotification('@nestjs/config');
    const { PostgresDatabase } = await load('persistence/postgres.database.js'),
      { migrate } = await load('persistence/schema.js');
    const schema = `notification_gateway_${randomUUID().replaceAll('-', '')}`,
      admin = new PostgresDatabase(
        new ConfigService({
          database: {
            connectionString:
              'postgres://wgo:wgo@127.0.0.1:5432/wgo_notification',
          },
        }),
      ),
      database = new PostgresDatabase(
        new ConfigService({
          database: {
            connectionString:
              'postgres://wgo:wgo@127.0.0.1:5432/wgo_notification',
            options: `-c search_path=${schema}`,
          },
        }),
      );
    let notification: any,
      gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await admin.pool.query(`CREATE SCHEMA ${schema}`);
      await migrate(database.pool);
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv('NEARBY_NOTIFICATIONS_ENABLED', 'true');
      const config = loadConfig();
      config.userAuth = frontendAuth;
      config.rateLimit.enabled = false;
      config.docs.enabled = false;
      const pub = createPublicKey(
        createPrivateKey({
          key: JSON.parse(frontendAuth.servicePrivateJwk),
          format: 'jwk',
        }),
      ).export({ format: 'jwk' });
      vi.stubEnv(
        'NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS',
        JSON.stringify({
          keys: [
            {
              ...pub,
              iss: 'wgo-http-gateway',
              alg: 'ES256',
              kid: 'frontend-test',
            },
          ],
        }),
      );
      // The real downstream guard must verify the Gateway-generated service signature.
      vi.stubEnv('NODE_ENV', 'production');
      const { NotificationController } = await load(
          'notification/notification.controller.js',
        ),
        { NearbyController } = await load('notification/nearby.controller.js'),
        { NotificationService } = await load(
          'notification/notification.service.js',
        ),
        { PostgresNotificationRepository } = await load(
          'persistence/postgres-notification.repository.js',
        ),
        { PostgresPushSubscriptionRepository } = await load(
          'persistence/postgres-push-subscription.repository.js',
        ),
        { PushSubscriptionService } = await load(
          'push-subscription/push-subscription.service.js',
        ),
        { PostgresEventStore } = await load(
          'persistence/postgres-event.store.js',
        ),
        { NearbySubscriptionService } = await load(
          'notification/nearby-subscription.service.js',
        );
      const repository = new PostgresNotificationRepository(database),
        notifications = new NotificationService(repository),
        subscriptions = new PushSubscriptionService(
          new PostgresPushSubscriptionRepository(database),
        );
      const module = await Test.createTestingModule({
        controllers: [NotificationController, NearbyController],
        providers: [
          { provide: NotificationService, useValue: notifications },
          { provide: PushSubscriptionService, useValue: subscriptions },
          {
            provide: PostgresEventStore,
            useValue: new PostgresEventStore(database),
          },
          {
            provide: NearbySubscriptionService,
            useValue: new NearbySubscriptionService(database),
          },
        ],
      }).compile();
      notification = module.createNestApplication();
      const { configureSwagger } = await load('swagger.js');
      configureSwagger(notification);
      await notification.listen(0, '127.0.0.1');
      config.services.notification = await notification.getUrl();
      gateway = await buildApp({ config, logger: false });
      const own = await notifications.create({
          userId: '123',
          type: 'TEST',
          title: 'own',
          body: 'own',
        }),
        other = await notifications.create({
          userId: '456',
          type: 'TEST',
          title: 'other',
          body: 'other',
        });
      const call = (
        method: 'GET' | 'PUT' | 'PATCH' | 'DELETE',
        path: string,
        payload?: Record<string, unknown>,
      ) =>
        gateway!.inject({
          method,
          url: `/api/v1/notifications${path}`,
          headers: { authorization: frontendBearer(), 'x-user-id': '456' },
          ...(payload ? { payload } : {}),
        });
      expect((await gateway.inject('/api/v1/notifications')).statusCode).toBe(
        401,
      );
      const list = await call('GET', '');
      expect(list.statusCode).toBe(200);
      expect(list.json().items.map((n: any) => n.notificationId)).toEqual([
        own.notificationId,
      ]);
      await call('DELETE', `/${encodeURIComponent(other.notificationId)}`);
      expect((await notifications.list('456')).items).toHaveLength(1);
      expect((await call('GET', '/unread-count')).json().count).toBe(1);
      expect(
        (
          await call('PATCH', '/settings', {
            rewards: false,
            votes: false,
            moderation: false,
          })
        ).json(),
      ).toMatchObject({
        rewards: false,
        votes: false,
        moderation: false,
        replies: true,
      });
      expect(
        (
          await call('PUT', '/nearby-subscription', {
            enabled: true,
            locationConsent: true,
            latitude: 37.5,
            longitude: 127,
            capturedAt: new Date().toISOString(),
          })
        ).statusCode,
      ).toBe(200);
      expect(
        (
          await database.pool.query(
            'SELECT user_id FROM notification_nearby_subscriptions',
          )
        ).rows,
      ).toEqual([{ user_id: '123' }]);
      expect((await call('DELETE', '/nearby-subscription')).statusCode).toBe(
        204,
      );
      expect(
        (
          await call('PUT', '/push-subscriptions', {
            token: 'isolated-e2e-token',
            platform: 'web',
          })
        ).statusCode,
      ).toBe(200);
      expect(await subscriptions.list('456')).toHaveLength(0);
      expect(await subscriptions.list('123')).toHaveLength(1);
      await call('DELETE', '/push-subscriptions', {
        token: 'isolated-e2e-token',
      });
      expect(await subscriptions.list('123')).toHaveLength(0);
      await call('PATCH', '/read-all');
      expect((await call('GET', '/unread-count')).json().count).toBe(0);
      const doc = (await (
        await fetch(`${config.services.notification}/docs/openapi.json`)
      ).json()) as ApiDocument;
      const merged = await mergeDocuments(
        [{ service: 'notification', document: doc }],
        config,
      );
      await validateDocument(merged);
      expect(
        merged.paths['/api/v1/notifications/nearby-subscription'].put.security,
      ).toEqual([{ notification__UserAccess: [] }]);
      expect(
        merged.paths['/api/v1/notifications/settings'].patch.requestBody
          .content['application/json'].schema.$ref,
      ).toContain('NotificationPreferencesPatch');
      expect(
        Object.keys(merged.paths).some((p) => p.startsWith('/internal')),
      ).toBe(false);
    } finally {
      await gateway?.close();
      await notification?.close();
      await database.onApplicationShutdown();
      await admin.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
      await admin.onApplicationShutdown();
      vi.unstubAllEnvs();
    }
  },
  30000,
);
