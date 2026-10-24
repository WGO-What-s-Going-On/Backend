import type { FastifyRequest } from 'fastify';
import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';
import { JwtAuthenticator } from '../src/realtime/authentication.js';

const jwtConfig = {
  secret: 'test-secret-that-is-at-least-32-characters',
  issuer: 'wgo-user-service',
  audience: 'wgo-api',
  cookieName: 'wgo_access_token',
};
const key = new TextEncoder().encode(jwtConfig.secret);
function request(
  authorization?: string,
  cookie?: string,
  rawHeaders?: string[],
): FastifyRequest {
  return {
    headers: authorization === undefined ? {} : { authorization },
    cookies: cookie ? { wgo_access_token: cookie } : {},
    raw: {
      rawHeaders:
        rawHeaders ??
        (authorization === undefined ? [] : ['Authorization', authorization]),
    },
  } as unknown as FastifyRequest;
}
async function token(
  changes: Record<string, unknown> = {},
  alg = 'HS256',
  typ = 'JWT',
  secret = key,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: '123',
    sid: randomUUID(),
    iss: jwtConfig.issuer,
    aud: jwtConfig.audience,
    iat: now,
    exp: now + 300,
    ...changes,
  })
    .setProtectedHeader({ alg, typ })
    .sign(secret);
}
const auth = new JwtAuthenticator(jwtConfig);
describe('User Access JWT contract', () => {
  it('accepts bearer and browser cookie with the same contract', async () => {
    const value = await token();
    expect(await auth.authenticate(request(`Bearer ${value}`))).toEqual({
      userId: '123',
    });
    expect(await auth.authenticate(request(undefined, value))).toEqual({
      userId: '123',
    });
  });
  it.each([
    { sub: 'user-123' },
    { sub: '0' },
    { sub: '9007199254740992' },
    { sub: 123 },
    { sid: undefined },
    { sid: 'not-a-uuid' },
    { iat: undefined },
    { exp: undefined },
    { iat: -1 },
    { iat: Math.floor(Date.now() / 1000) + 60 },
    {
      iat: Math.floor(Date.now() / 1000) - 60,
      exp: Math.floor(Date.now() / 1000) - 30,
    },
    { iss: 'another-service' },
    { aud: 'wgo-post-service' },
  ])('rejects invalid claims %j', async (changes) => {
    await expect(
      auth.authenticate(request(`Bearer ${await token(changes)}`)),
    ).rejects.toThrow();
  });
  it('rejects wrong signature, algorithm and service-token type', async () => {
    for (const value of [
      await token(
        {},
        'HS256',
        'JWT',
        new TextEncoder().encode('other-secret-that-is-at-least-32-characters'),
      ),
      await token({}, 'HS384'),
      await token({}, 'HS256', 'wgo-service+jwt'),
    ]) {
      await expect(
        auth.authenticate(request(`Bearer ${value}`)),
      ).rejects.toThrow();
    }
  });
  it('does not fall back to a valid cookie when an explicit header is malformed or invalid', async () => {
    const cookie = await token();
    for (const header of [
      '',
      'Basic credential',
      'Bearer invalid',
      `Bearer  ${cookie}`,
    ]) {
      await expect(
        auth.authenticate(request(header, cookie)),
      ).rejects.toThrow();
    }
  });
  it('rejects duplicate Authorization headers even with a valid cookie', async () => {
    const value = await token();
    await expect(
      auth.authenticate(
        request(`Bearer ${value}`, value, [
          'Authorization',
          `Bearer ${value}`,
          'authorization',
          `Bearer ${value}`,
        ]),
      ),
    ).rejects.toThrow();
  });
  it('rejects missing credentials', async () => {
    await expect(auth.authenticate(request())).rejects.toThrow();
  });
});
