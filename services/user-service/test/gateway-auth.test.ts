import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import { APP_GUARD } from '@nestjs/core';
import type { INestApplication } from '@nestjs/common';
import { generateKeyPairSync } from 'node:crypto';
import { SignJWT } from 'jose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GatewayAuthGuard } from '../src/http-auth/gateway-auth.guard.js';
import { UsersController } from '../src/users/users.controller.js';
import { UsersService } from '../src/users/users.service.js';
import { AuthController } from '../src/auth/auth.controller.js';
import { AuthService } from '../src/auth/auth.service.js';
import { HealthController } from '../src/health/health.controller.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const next = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const original = process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
const sid = '5e614031-b7fb-47bf-9d0d-23434eb18acd';
function bearer(
  claims: Record<string, unknown> = {},
  header: Record<string, unknown> = {},
  key = privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    iss: 'wgo-http-gateway',
    sub: 'http-gateway',
    aud: 'wgo-user-service',
    iat: now,
    exp: now + 30,
    ...claims,
  })
    .setProtectedHeader({
      alg: 'ES256',
      typ: 'wgo-service+jwt',
      kid: 'gateway-1',
      ...header,
    })
    .sign(key);
}
const users = {
  getProfile: vi.fn(async (userId: string) => ({ userId })),
  changeBlock: vi.fn(async () => {}),
  listBlocks: vi.fn(async () => ({ items: [], nextCursor: null })),
};
const auth = {
  loginWithKakao: vi.fn(async () => ({ accessToken: 'issued' })),
  logout: vi.fn(async () => {}),
};
describe('User REST Gateway trust boundary', () => {
  let app: INestApplication;
  beforeAll(async () => {
    process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          iss: 'wgo-http-gateway',
          kid: 'gateway-1',
        },
        {
          ...next.publicKey.export({ format: 'jwk' }),
          alg: 'ES256',
          iss: 'wgo-http-gateway',
          kid: 'gateway-2',
        },
      ],
    });
    const module = await Test.createTestingModule({
      controllers: [UsersController, AuthController, HealthController],
      providers: [
        { provide: UsersService, useValue: users },
        { provide: AuthService, useValue: auth },
        { provide: APP_GUARD, useClass: GatewayAuthGuard },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app?.close();
    if (original === undefined)
      delete process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
    else process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = original;
  });

  it('requires verified identity for every block method, including dynamic DELETE', async () => {
    const token = await bearer();
    await request(app.getHttpServer())
      .post('/api/v1/users/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-User-Id', '42')
      .send({ blockedUserId: '123' })
      .expect(204);
    await request(app.getHttpServer())
      .get('/api/v1/users/me/blocks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-User-Id', '42')
      .expect(200);
    await request(app.getHttpServer())
      .delete('/api/v1/users/me/blocks/123')
      .set('Authorization', `Bearer ${token}`)
      .set('X-User-Id', '42')
      .expect(204);
    expect(users.changeBlock).toHaveBeenCalledWith('42', '123', false);
    await request(app.getHttpServer())
      .delete('/api/v1/users/me/blocks/123')
      .set('X-User-Id', '42')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/users/123/blocks')
      .set('Authorization', `Bearer ${token}`)
      .set('X-User-Id', '42')
      .expect(404);
  });

  it('rejects direct identity headers before calling business logic', async () => {
    users.getProfile.mockClear();
    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('X-User-Id', '42')
      .expect(401);
    expect(users.getProfile).not.toHaveBeenCalled();
  });
  it('requires service authentication even for login', async () => {
    auth.loginWithKakao.mockClear();
    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .send({ authorizationCode: 'code' })
      .expect(401);
    expect(auth.loginWithKakao).not.toHaveBeenCalled();
    await request(app.getHttpServer())
      .post('/api/v1/auth/kakao')
      .set('Authorization', `Bearer ${await bearer()}`)
      .send({ authorizationCode: 'code' })
      .expect(201);
  });
  it('passes authenticated context to the unchanged controller and service', async () => {
    const result = await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await bearer()}`)
      .set('X-User-Id', '42')
      .expect(200);
    expect(result.body).toEqual({ userId: '42' });
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${await bearer()}`)
      .set('X-User-Id', '42')
      .set('X-Session-Id', sid)
      .expect(204);
    expect(auth.logout).toHaveBeenCalledWith('42', sid);
  });
  it('accepts the newly registered public key during key rotation', async () => {
    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set(
        'Authorization',
        `Bearer ${await bearer({}, { kid: 'gateway-2' }, next.privateKey)}`,
      )
      .set('X-User-Id', '42')
      .expect(200);
  });
  it.each([
    { iss: 'wgo-post-service' },
    { sub: 'post-service' },
    { aud: 'wgo-map-service' },
    { aud: ['wgo-user-service', 'wgo-map-service'] },
    { exp: 1 },
    { exp: 9999999999 },
    { iat: 9999999999 },
    { iat: null },
    { nbf: 9999999999 },
  ])('rejects invalid service claims %j', async (claims) => {
    await request(app.getHttpServer())
      .get('/api/v1/users/me')
      .set('Authorization', `Bearer ${await bearer(claims)}`)
      .set('X-User-Id', '42')
      .expect(401);
  });
  it.each([{ kid: 'unknown' }, { typ: 'JWT' }])(
    'rejects invalid service headers %j',
    async (header) => {
      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${await bearer({}, header)}`)
        .set('X-User-Id', '42')
        .expect(401);
    },
  );
  it('rejects incorrect signatures and user access tokens', async () => {
    const wrong = await bearer({}, {}, next.privateKey);
    const user = await new SignJWT({ sub: '42', sid })
      .setProtectedHeader({ alg: 'HS256' })
      .sign(
        new TextEncoder().encode('test-access-secret-with-at-least-32-bytes'),
      );
    for (const token of [wrong, user])
      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${token}`)
        .set('X-User-Id', '42')
        .expect(401);
  });
  it('rejects missing and ambiguous identity headers', async () => {
    for (const value of ['', '01', '42, 99'])
      await request(app.getHttpServer())
        .get('/api/v1/users/me')
        .set('Authorization', `Bearer ${await bearer()}`)
        .set('X-User-Id', value)
        .expect(401);
    await request(app.getHttpServer())
      .post('/api/v1/auth/logout')
      .set('Authorization', `Bearer ${await bearer()}`)
      .set('X-User-Id', '42')
      .expect(401);
  });
  it('denies methods outside the allowlist even with a valid Gateway token', async () => {
    await request(app.getHttpServer())
      .head('/api/v1/users/me')
      .set('Authorization', `Bearer ${await bearer()}`)
      .set('X-User-Id', '42')
      .expect(403);
  });
  it('keeps liveness independent from authentication', async () => {
    await request(app.getHttpServer()).get('/health/live').expect(200);
  });
  it('rejects missing keys and private keys at initialization', () => {
    const valid = process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
    try {
      delete process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
      expect(() => new GatewayAuthGuard()).toThrow(
        'USER_HTTP_GATEWAY_TRUSTED_JWKS',
      );
      process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = JSON.stringify({
        keys: [
          {
            ...privateKey.export({ format: 'jwk' }),
            alg: 'ES256',
            iss: 'wgo-http-gateway',
            kid: 'gateway-1',
          },
        ],
      });
      expect(() => new GatewayAuthGuard()).toThrow(
        'USER_HTTP_GATEWAY_TRUSTED_JWKS',
      );
    } finally {
      process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = valid!;
    }
  });
});
