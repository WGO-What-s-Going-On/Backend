import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import { type INestApplication } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import { DataSource } from 'typeorm';
import request from 'supertest';
import { beforeAll, afterAll, describe, it, expect, vi } from 'vitest';
import { NotificationBlocksController } from '../src/users/notification-blocks.controller.js';
import { GatewayAuthGuard } from '../src/http-auth/gateway-auth.guard.js';

describe('Notification read-only User block contract', () => {
  let app: INestApplication;
  const gateway = generateKeyPairSync('ec', { namedCurve: 'P-256' }),
    notification = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const oldGateway = process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS,
    oldNotification = process.env.USER_NOTIFICATION_TRUSTED_JWKS;
  const db = { query: vi.fn() };
  const token = (
    claims: Record<string, unknown> = {},
    key = notification.privateKey,
  ) =>
    new SignJWT({
      iss: 'wgo-notification-service',
      sub: 'notification-service',
      aud: 'wgo-user-service',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 30,
      ...claims,
    })
      .setProtectedHeader({
        alg: 'ES256',
        typ: 'wgo-service+jwt',
        kid: 'notification-1',
      })
      .sign(key);
  beforeAll(async () => {
    process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...gateway.publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          iss: 'wgo-http-gateway',
          kid: 'gateway-1',
        },
      ],
    });
    process.env.USER_NOTIFICATION_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...notification.publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          iss: 'wgo-notification-service',
          kid: 'notification-1',
        },
      ],
    });
    const mod = await Test.createTestingModule({
      controllers: [NotificationBlocksController],
      providers: [
        { provide: DataSource, useValue: db },
        { provide: APP_GUARD, useClass: GatewayAuthGuard },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
    if (oldGateway === undefined)
      delete process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
    else process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = oldGateway;
    if (oldNotification === undefined)
      delete process.env.USER_NOTIFICATION_TRUSTED_JWKS;
    else process.env.USER_NOTIFICATION_TRUSTED_JWKS = oldNotification;
  });
  const endpoint = '/internal/notifications/blocks/check';
  it('requires the distinct Notification service key and rejects forwarded identities', async () => {
    for (const auth of [
      undefined,
      await token({}, gateway.privateKey),
      await token({ aud: 'wrong' }),
      await token({ exp: Math.floor(Date.now() / 1000) - 1 }),
    ]) {
      const req = request(app.getHttpServer())
        .post(endpoint)
        .set('x-wgo-user-id', '1');
      if (auth) req.set('Authorization', `Bearer ${auth}`);
      await req.send({ recipientId: '1', actorIds: ['2'] }).expect(401);
    }
    expect(db.query).not.toHaveBeenCalled();
  });
  it('returns bilateral blocks and inactive recipients without exposing profile or block-list data', async () => {
    db.query
      .mockResolvedValueOnce([{ status: 'SUSPENDED' }])
      .mockResolvedValueOnce([{ actor_id: '2', blocked: true }]);
    const response = await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', `Bearer ${await token()}`)
      .send({ recipientId: '1', actorIds: ['2'] })
      .expect(200);
    expect(response.body).toEqual({
      recipientId: '1',
      recipientActive: false,
      actors: [{ actorId: '2', blocked: true }],
    });
    expect(db.query.mock.calls[1]?.[0]).toContain('b.blocker_user_id=actor.id');
  });
  it('rejects malformed or unknown identities instead of assuming unblocked', async () => {
    for (const body of [
      { recipientId: '01', actorIds: ['2'] },
      { recipientId: '1', actorIds: [] },
      { recipientId: '1', actorIds: ['2'], admin: true },
    ])
      await request(app.getHttpServer())
        .post(endpoint)
        .set('Authorization', `Bearer ${await token()}`)
        .send(body)
        .expect(400);
    db.query
      .mockResolvedValueOnce([{ status: 'ACTIVE' }])
      .mockResolvedValueOnce([]);
    await request(app.getHttpServer())
      .post(endpoint)
      .set('Authorization', `Bearer ${await token()}`)
      .send({ recipientId: '1', actorIds: ['2'] })
      .expect(401);
  });
});
