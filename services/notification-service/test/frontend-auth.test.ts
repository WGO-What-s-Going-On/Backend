import { afterEach, expect, it, vi } from 'vitest';
import { generateKeyPairSync, sign } from 'node:crypto';
import { gatewayIdentity } from '../src/gateway-auth.js';
afterEach(() => vi.unstubAllEnvs());
it('accepts gateway identity only for its audience and signed user', () => {
  const { privateKey, publicKey } = generateKeyPairSync('ec', {
    namedCurve: 'prime256v1',
  });
  vi.stubEnv(
    'NOTIFICATION_HTTP_GATEWAY_TRUSTED_JWKS',
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
        aud: 'wgo-notification-service',
        userId: '12',
        iat: now,
        exp: now + 30,
        ...changes,
      }),
    ).toString('base64url');
    return `Bearer ${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  expect(gatewayIdentity(token(), '12')).toBe(true);
  expect(gatewayIdentity(token(), '13')).toBe(false);
  expect(gatewayIdentity(token({ aud: 'wgo-other-service' }), '12')).toBe(
    false,
  );
  expect(gatewayIdentity(token({ exp: 0 }), '12')).toBe(false);
  expect(gatewayIdentity(token({ iss: 'wgo-ws-gateway' }), '12')).toBe(false);
  expect(gatewayIdentity(undefined, '12')).toBe(false);
});
