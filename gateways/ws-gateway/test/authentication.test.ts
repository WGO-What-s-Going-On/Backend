import type { FastifyRequest } from 'fastify';
import { SignJWT } from 'jose';
import { describe, expect, it } from 'vitest';

import { JwtAuthenticator } from '../src/realtime/authentication.js';

const jwtConfig = {
  secret: 'test-secret-that-is-at-least-32-characters',
  issuer: 'wgo-user-service',
  audience: 'wgo-realtime-gateway',
  cookieName: 'wgo_access_token',
};

function requestWithToken(token: string): FastifyRequest {
  return {
    headers: { authorization: `Bearer ${token}` },
    cookies: {},
  } as unknown as FastifyRequest;
}

describe('JwtAuthenticator', () => {
  it('maps a verified JWT subject to userId', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuer(jwtConfig.issuer)
      .setAudience(jwtConfig.audience)
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(jwtConfig.secret));

    const user = await new JwtAuthenticator(jwtConfig).authenticate(
      requestWithToken(token),
    );

    expect(user).toEqual({ userId: 'user-123' });
  });

  it('rejects a token issued for a different audience', async () => {
    const token = await new SignJWT({})
      .setProtectedHeader({ alg: 'HS256' })
      .setSubject('user-123')
      .setIssuer(jwtConfig.issuer)
      .setAudience('another-service')
      .setExpirationTime('5m')
      .sign(new TextEncoder().encode(jwtConfig.secret));

    await expect(
      new JwtAuthenticator(jwtConfig).authenticate(requestWithToken(token)),
    ).rejects.toThrow('invalid or expired');
  });
});
