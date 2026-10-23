import { generateKeyPairSync, sign, createHmac } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import {
  serviceIdentity,
  verifiedWsUser,
} from '../src/post/presentation/service-auth.js';

const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const other = generateKeyPairSync('ec', { namedCurve: 'P-256' });
const original = { ...process.env };
afterEach(() => {
  process.env = { ...original };
});
function configure() {
  process.env.POST_WS_TRUSTED_JWKS = JSON.stringify({
    keys: [
      {
        ...keys.publicKey.export({ format: 'jwk' }),
        kid: 'ws-1',
        alg: 'ES256',
        iss: 'wgo-ws-gateway',
      },
    ],
  });
}
function token(
  claims: object = {},
  header: object = {},
  key = keys.privateKey,
) {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(
    JSON.stringify({
      alg: 'ES256',
      typ: 'wgo-service+jwt',
      kid: 'ws-1',
      ...header,
    }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'ws-gateway',
      iss: 'wgo-ws-gateway',
      aud: 'wgo-post-service',
      iat: now,
      exp: now + 30,
      ...claims,
    }),
  ).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${encodedHeader}.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  return `Bearer ${encodedHeader}.${payload}.${signature}`;
}
describe('WS service authentication', () => {
  it('requires an authenticated caller before trusting user context', () => {
    configure();
    expect(verifiedWsUser(token(), '123')).toBe(123);
    expect(serviceIdentity(token(), '123')).toBe(123);
    expect(serviceIdentity(token())).toBeNull();
    expect(() => verifiedWsUser(undefined, '123')).toThrow(
      'Invalid WS service token',
    );
  });
  it.each([
    { sub: 'http-gateway' },
    { iss: 'other' },
    { aud: 'other' },
    { exp: 0 },
    { exp: 9999999999 },
    { iat: 9999999999 },
    { iat: 1.5 },
    { nbf: 9999999999 },
  ])('rejects service claims %j', (claims) => {
    configure();
    expect(() => verifiedWsUser(token(claims), '123')).toThrow(
      'Invalid WS service token',
    );
  });
  it.each([{ kid: 'unknown' }, { typ: 'JWT' }, { alg: 'HS256' }])(
    'rejects wrong token headers %j',
    (header) => {
      configure();
      expect(() => verifiedWsUser(token({}, header), '123')).toThrow(
        'Invalid WS service token',
      );
    },
  );
  it('rejects an untrusted signature', () => {
    configure();
    expect(() =>
      verifiedWsUser(token({}, {}, other.privateKey), '123'),
    ).toThrow('Invalid WS service token');
  });
  it.each([undefined, '0', '01', '-1', '123,456', '9007199254740992'])(
    'rejects invalid identity %s',
    (id) => {
      configure();
      expect(() => verifiedWsUser(token(), id)).toThrow(
        'Verified user context required',
      );
    },
  );
  it('fails closed on missing key configuration and never accepts a private key', () => {
    delete process.env.POST_WS_TRUSTED_JWKS;
    expect(() => verifiedWsUser(token(), '123')).toThrow('public keys');
    process.env.POST_WS_TRUSTED_JWKS = JSON.stringify({
      keys: [
        {
          ...keys.privateKey.export({ format: 'jwk' }),
          kid: 'ws-1',
          alg: 'ES256',
          iss: 'wgo-ws-gateway',
        },
      ],
    });
    expect(() => verifiedWsUser(token(), '123')).toThrow('public keys');
  });
  it('keeps existing HS256 calls compatible but rejects them for new participation', () => {
    configure();
    const secret = 'legacy-ws-service-secret-at-least-32-bytes';
    process.env.WS_SERVICE_JWT_SECRET = secret;
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const now = Math.floor(Date.now() / 1000);
    const payload = Buffer.from(
      JSON.stringify({
        sub: 'ws-gateway',
        iss: 'wgo-ws-gateway',
        aud: 'wgo-post-service',
        iat: now,
        exp: now + 30,
        userId: 123,
      }),
    ).toString('base64url');
    const legacy = `Bearer ${header}.${payload}.${createHmac('sha256', secret).update(`${header}.${payload}`).digest('base64url')}`;
    expect(serviceIdentity(legacy)).toBe(123);
    expect(() => verifiedWsUser(legacy, '123')).toThrow(
      'Invalid WS service token',
    );
  });
});
