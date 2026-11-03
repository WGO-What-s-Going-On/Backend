import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  mergeDocuments,
  validateDocument,
  type ApiDocument,
} from '../src/openapi.js';
import { frontendAuth } from './frontend-auth-fixture.js';

const load = (path: string) =>
  import(
    new URL(
      `../../../services/notification-service/dist/${path}`,
      import.meta.url,
    ).href
  );

// Uses the built Notification controllers, not a handwritten approximation of their contract.
// Run after building notification-service with RUN_NOTIFICATION_GATEWAY_E2E=1; no DB/Redis/FCM is used.
it.skipIf(process.env.RUN_NOTIFICATION_GATEWAY_E2E !== '1')(
  'serves all current Notification OpenAPI operations with preserved schemas and public Bearer authentication',
  async () => {
    const requireNotification = createRequire(
      new URL(
        '../../../services/notification-service/package.json',
        import.meta.url,
      ),
    );
    const { Test } = requireNotification('@nestjs/testing');
    const { NotificationController } = await load(
      'notification/notification.controller.js',
    );
    const { NearbyController } = await load(
      'notification/nearby.controller.js',
    );
    const { NotificationService } = await load(
      'notification/notification.service.js',
    );
    const { PushSubscriptionService } = await load(
      'push-subscription/push-subscription.service.js',
    );
    const { PostgresEventStore } = await load(
      'persistence/postgres-event.store.js',
    );
    const { NearbySubscriptionService } = await load(
      'notification/nearby-subscription.service.js',
    );
    const module = await Test.createTestingModule({
      controllers: [NotificationController, NearbyController],
      providers: [
        NotificationService,
        PushSubscriptionService,
        PostgresEventStore,
        NearbySubscriptionService,
      ].map((provide) => ({ provide, useValue: {} })),
    }).compile();
    const notification = module.createNestApplication();
    const { configureSwagger } = await load('swagger.js');
    configureSwagger(notification);
    const directory = await mkdtemp(
      join(tmpdir(), 'wgo-notification-openapi-'),
    );
    let gateway: Awaited<ReturnType<typeof buildApp>> | undefined;
    try {
      await notification.listen(0, '127.0.0.1');
      const source = (await (
        await fetch(`${await notification.getUrl()}/docs/openapi.json`)
      ).json()) as ApiDocument;
      const original = JSON.stringify(source);
      const config = loadConfig();
      config.userAuth = frontendAuth;
      config.rateLimit.enabled = true;
      config.docs.enabled = true;
      config.docs.live = false;
      config.docs.file = join(directory, 'openapi.json');
      const merged = await mergeDocuments(
        [{ service: 'notification', document: source }],
        config,
      );
      await validateDocument(merged);
      expect(JSON.stringify(source)).toBe(original);
      expect(merged['x-services-without-public-operations']).toEqual([]);
      expect(Object.keys(merged.paths).sort()).toEqual(
        Object.keys(source.paths).sort(),
      );
      let operations = 0;
      for (const [path, item] of Object.entries(source.paths) as [
        string,
        any,
      ][]) {
        for (const [method, operation] of Object.entries(item) as [
          string,
          any,
        ][]) {
          operations++;
          const publicOperation = merged.paths[path][method];
          expect(publicOperation.security).toEqual([
            { notification__UserAccess: [] },
          ]);
          expect(
            publicOperation.parameters.some((p: any) => p.in === 'header'),
          ).toBe(false);
          // Only component names change; body and response schemas remain service-owned.
          const renamed = (value: unknown) =>
            JSON.parse(
              JSON.stringify(value).replaceAll(
                '#/components/schemas/',
                '#/components/schemas/notification__',
              ),
            );
          if (operation.requestBody)
            expect(publicOperation.requestBody).toEqual(
              renamed(operation.requestBody),
            );
          for (const [status, response] of Object.entries(
            operation.responses,
          ) as [string, any][]) {
            expect(publicOperation.responses[status].content).toEqual(
              response.content === undefined
                ? undefined
                : renamed(response.content),
            );
          }
          for (const status of [
            '400',
            '401',
            '413',
            '429',
            '500',
            '502',
            '503',
            '504',
          ])
            expect(publicOperation.responses[status]).toBeDefined();
          expect(
            publicOperation.responses['400']['x-gateway-response'].content[
              'application/json'
            ].schema.properties.code.enum,
          ).toEqual(['GATEWAY_BAD_REQUEST']);
          expect(
            publicOperation.responses['401']['x-gateway-response'].content[
              'application/json'
            ].schema.properties.code.enum,
          ).toEqual(['GATEWAY_UNAUTHORIZED']);
        }
      }
      expect(operations).toBe(14);
      expect(merged.components.securitySchemes).toEqual({
        notification__UserAccess: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT (HS256)',
        },
      });
      expect(
        merged.components.schemas.notification__RegisterPushSubscriptionDto
          .properties.platform.enum,
      ).toEqual(['web', 'ios', 'android']);
      const list =
        merged.paths['/api/v1/notifications'].get.responses['200'].content[
          'application/json'
        ].schema;
      expect(list.properties.items.items.properties).toHaveProperty(
        'commentId',
      );
      expect(
        list.properties.items.items.properties.metadata.additionalProperties,
      ).toBe(true);
      expect(
        merged.paths['/api/v1/notifications/nearby-subscription'].put.responses[
          '503'
        ]['x-gateway-response'].content['application/json'].schema.properties
          .code.enum,
      ).toEqual(['GATEWAY_UPSTREAM_UNAVAILABLE']);
      await writeFile(config.docs.file, JSON.stringify(merged));
      // Verify the rate-limit documentation without starting a Redis-backed limiter.
      config.rateLimit.enabled = false;
      gateway = await buildApp({ config, logger: false });
      const served = await gateway.inject('/docs/openapi.json');
      expect(served.statusCode).toBe(200);
      expect(served.json()).toEqual(merged);
      expect((await gateway.inject('/api/v1/notifications')).statusCode).toBe(
        401,
      );
    } finally {
      await gateway?.close();
      await notification.close();
      await rm(directory, { recursive: true, force: true });
    }
  },
  30000,
);
