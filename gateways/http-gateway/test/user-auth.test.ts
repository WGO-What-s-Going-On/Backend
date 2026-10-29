import type { ServiceName } from '../src/config.js';
import type { IncomingHttpHeaders } from 'node:http';
import Fastify from 'fastify';
import { generateKeyPairSync } from 'node:crypto';
import { jwtVerify, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const { privateKey, publicKey } = generateKeyPairSync('ec', {
  namedCurve: 'P-256',
});
const secret = new TextEncoder().encode(
  'test-user-access-secret-at-least-32-bytes',
);
const sid = '5e614031-b7fb-47bf-9d0d-23434eb18acd';
const cleanup: Array<() => Promise<unknown>> = [];
const originalEnv = { ...process.env };
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
  process.env = { ...originalEnv };
});
async function setup(configured = true, service: ServiceName = 'user') {
  process.env = {
    NODE_ENV: 'test',
    RATE_LIMIT_ENABLED: 'false',
    LOG_PRETTY: 'false',
  };
  const upstream = Fastify();
  upstream.all('/*', async (request) => {
    const { payload, protectedHeader } = await jwtVerify(
      request.headers.authorization!.slice(7),
      publicKey,
      {
        algorithms: ['ES256'],
        issuer: 'wgo-http-gateway',
        subject: 'http-gateway',
        audience: `wgo-${service}-service`,
        typ: 'wgo-service+jwt',
      },
    );
    return {
      signedUserId: payload.userId ?? null,
      userId: request.headers['x-user-id'] ?? null,
      sessionId: request.headers['x-session-id'] ?? null,
      lifetime: payload.exp! - payload.iat!,
      kid: protectedHeader.kid,
      path: request.url,
    };
  });
  const url = await upstream.listen({ host: '127.0.0.1', port: 0 });
  cleanup.push(() => upstream.close());
  const config = loadConfig();
  config.services[service] = url;
  if (configured)
    config.userAuth = {
      accessSecret: new TextDecoder().decode(secret),
      issuer: 'wgo-user',
      audience: 'wgo-api',
      servicePrivateJwk: JSON.stringify({
        ...privateKey.export({ format: 'jwk' }),
        kid: 'gateway-1',
        alg: 'ES256',
      }),
    };
  const app = await buildApp({ config, logger: false });
  cleanup.push(() => app.close());
  return app;
}
function access(overrides: Record<string, unknown> = {}, key = secret) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: '42',
    sid,
    iss: 'wgo-user',
    aud: 'wgo-api',
    iat: now,
    exp: now + 900,
    ...overrides,
  })
    .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
    .sign(key);
}
describe('User route authentication', () => {
  it.each([
    ['post', 'posts'],
    ['map', 'location'],
    ['notification', 'notifications'],
    ['moderation', 'moderation/reports'],
  ] as const)(
    'authenticates %s and binds the signed user claim',
    async (service, path) => {
      const app = await setup(true, service);
      const response = await app.inject({
        method: 'GET',
        url: `/api/v1/${path}`,
        headers: {
          authorization: `Bearer ${await access()}`,
          'x-user-id': '999',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        userId: '42',
        signedUserId: '42',
        lifetime: 30,
      });
      expect(
        (
          await app.inject({
            method: 'GET',
            url: `/api/v1/${path}`,
            headers: { 'x-user-id': '42' },
          })
        ).statusCode,
      ).toBe(401);
    },
  );
  it('replaces forged identity with JWT claims and a separate Gateway credential', async () => {
    const app = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      headers: {
        authorization: `Bearer ${await access()}`,
        'x-user-id': '99',
        'x-session-id': 'forged',
      },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      userId: '42',
      sessionId: sid,
      lifetime: 30,
      kid: 'gateway-1',
    });
  });
  it.each([
    '/api/v1/auth/kakao',
    '/api/v1/auth/refresh',
    '/api/v1/terms',
    '/api/v1/users/nickname/availability?nickname=test',
  ])(
    'authenticates public upstream %s without forwarding external credentials',
    async (url) => {
      const app = await setup();
      const response = await app.inject({
        method: url.includes('/auth/') ? 'POST' : 'GET',
        url,
        headers: {
          authorization: 'Bearer forged',
          'x-user-id': '99',
          'x-session-id': 'forged',
        },
      });
      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({
        userId: null,
        sessionId: null,
        kid: 'gateway-1',
      });
    },
  );
  it.each([
    {},
    { authorization: 'Bearer malformed' },
    { 'x-user-id': '42' },
    { authorization: ['Bearer first', 'Bearer second'] },
  ])('rejects unverified identity %j', async (headers) => {
    const app = await setup();
    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/users/me',
      // Deliberately send duplicate Authorization fields rejected by normal client types.
      headers: headers as unknown as IncomingHttpHeaders,
    });
    expect(response.statusCode).toBe(401);
    expect(response.json().code).toBe('GATEWAY_UNAUTHORIZED');
  });
  it.each([
    { exp: 1 },
    { iss: 'other' },
    { aud: 'other' },
    { sub: '01' },
    { sub: '9007199254740992' },
    { sid: '' },
    { sid: null },
    { exp: null },
    { iat: 9999999999 },
    { nbf: 9999999999 },
  ])('rejects invalid user claims %j', async (claims) => {
    const app = await setup();
    const response = await app.inject({
      method: 'POST',
      url: '/api/v1/auth/logout',
      headers: { authorization: `Bearer ${await access(claims)}` },
    });
    expect(response.statusCode).toBe(401);
  });
  it('rejects a wrong signature', async () => {
    const app = await setup();
    const token = await access(
      {},
      new TextEncoder().encode('another-secret-with-at-least-32-bytes'),
    );
    expect(
      (
        await app.inject({
          method: 'GET',
          url: '/api/v1/users/me',
          headers: { authorization: `Bearer ${token}` },
        })
      ).statusCode,
    ).toBe(401);
  });
  it('fails closed when authentication is unconfigured', async () => {
    const app = await setup(false);
    expect((await app.inject('/api/v1/users/me')).statusCode).toBe(503);
    expect((await app.inject('/health/live')).statusCode).toBe(200);
  });
  it.each([
    'GET /api/v1/auth/kakao',
    'DELETE /api/v1/users/me',
    'GET /api/v1/users/new',
    'GET /api/v1/users/me/',
  ])('does not implicitly expose %s', async (operation) => {
    const app = await setup();
    const [method, url] = operation.split(' ');
    const response = await app.inject({ method: method as 'GET', url: url! });
    expect(response.statusCode).toBe(404);
  });
});
