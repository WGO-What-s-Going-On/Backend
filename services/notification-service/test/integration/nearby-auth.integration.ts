import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync, sign } from 'node:crypto';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { harness } from './harness.js';
import { NearbyController } from '../../src/notification/nearby.controller.js';
import { NearbySubscriptionService } from '../../src/notification/nearby-subscription.service.js';

describe('nearby API Gateway signature and owner isolation with PostgreSQL', () => {
  let h: Awaited<ReturnType<typeof harness>>, app: INestApplication;
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    url = '/api/v1/notifications/nearby-subscription';
  const bearer = (userId: string) => {
    const now = Math.floor(Date.now() / 1000),
      h = Buffer.from(
        JSON.stringify({
          alg: 'ES256',
          typ: 'wgo-service+jwt',
          kid: 'gateway-1',
        }),
      ).toString('base64url'),
      p = Buffer.from(
        JSON.stringify({
          iss: 'wgo-http-gateway',
          sub: 'http-gateway',
          aud: 'wgo-notification-service',
          userId,
          iat: now,
          exp: now + 30,
        }),
      ).toString('base64url');
    return `Bearer ${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: keys.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  beforeEach(async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('NEARBY_NOTIFICATIONS_ENABLED', 'true');
    vi.stubEnv(
      'NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...keys.publicKey.export({ format: 'jwk' }),
            alg: 'ES256',
            iss: 'wgo-http-gateway',
            kid: 'gateway-1',
          },
        ],
      }),
    );
    h = await harness();
    const module = await Test.createTestingModule({
      controllers: [NearbyController],
      providers: [
        {
          provide: NearbySubscriptionService,
          useValue: new NearbySubscriptionService(h.database),
        },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterEach(async () => {
    await app.close();
    await h.cleanup();
    vi.unstubAllEnvs();
  });
  it('rejects header spoofing and lets only the signed owner read or withdraw their consent', async () => {
    const body = {
      enabled: true,
      locationConsent: true,
      latitude: 37.5,
      longitude: 127,
      capturedAt: new Date().toISOString(),
    };
    await request(app.getHttpServer())
      .put(url)
      .set('x-user-id', '1')
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .put(url)
      .set('Authorization', bearer('1'))
      .set('x-user-id', '2')
      .send(body)
      .expect(401);
    await request(app.getHttpServer())
      .put(url)
      .set('Authorization', bearer('1'))
      .set('x-user-id', '1')
      .send(body)
      .expect(200);
    const other = await request(app.getHttpServer())
      .get(url)
      .set('Authorization', bearer('2'))
      .set('x-user-id', '2')
      .expect(200);
    expect(other.body.enabled).toBe(false);
    await request(app.getHttpServer())
      .delete(url)
      .set('Authorization', bearer('2'))
      .set('x-user-id', '2')
      .expect(204);
    expect(
      (
        await h.database.pool.query(
          'SELECT user_id FROM notification_nearby_subscriptions',
        )
      ).rows,
    ).toEqual([{ user_id: '1' }]);
    await request(app.getHttpServer())
      .delete(url)
      .set('Authorization', bearer('1'))
      .set('x-user-id', '1')
      .expect(204);
    expect(
      (
        await h.database.pool.query(
          'SELECT user_id FROM notification_nearby_subscriptions',
        )
      ).rowCount,
    ).toBe(0);
  });
});
