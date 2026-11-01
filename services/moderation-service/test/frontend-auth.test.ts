import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { GatewayAuthGuard } from '../src/reports/gateway-auth.guard.js';
afterEach(() => vi.unstubAllEnvs());
it('keeps Gateway signed-user, issuer, audience and expiry checks after report consolidation', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  vi.stubEnv(
    'MODERATION_HTTP_GATEWAY_TRUSTED_JWKS',
    JSON.stringify({
      keys: [
        {
          ...publicKey.export({ format: 'jwk' }),
          kid: 'test',
          alg: 'ES256',
          iss: 'wgo-http-gateway',
        },
      ],
    }),
  );
  const token = (changes: object = {}) => {
    const h = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid: 'test' }),
    ).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const p = Buffer.from(
      JSON.stringify({
        iss: 'wgo-http-gateway',
        sub: 'http-gateway',
        aud: 'wgo-moderation-service',
        userId: '12',
        iat: now,
        exp: now + 30,
        ...changes,
      }),
    ).toString('base64url');
    return `Bearer ${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  const guard = new GatewayAuthGuard();
  const check = (authorization: string | undefined, userId: string) =>
    guard.canActivate({
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization, 'x-user-id': userId },
          rawHeaders: ['Authorization', authorization, 'X-User-Id', userId],
        }),
      }),
    } as never);
  await expect(check(token(), '12')).resolves.toBe(true);
  for (const [authorization, userId] of [
    [token(), '13'],
    [token({ aud: 'wgo-other-service' }), '12'],
    [token({ exp: 0 }), '12'],
    [token({ iss: 'wgo-ws-gateway' }), '12'],
    [undefined, '12'],
  ] as const) {
    await expect(check(authorization, userId)).rejects.toMatchObject({
      status: 401,
    });
  }
});
