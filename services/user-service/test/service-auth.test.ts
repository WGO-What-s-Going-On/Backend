import {
  createHmac,
  generateKeyPairSync,
  sign,
  type KeyObject,
} from 'node:crypto';
import { Metadata } from '@grpc/grpc-js';
import { describe, expect, it } from 'vitest';
import { serviceCaller, trustedKeys } from '../src/grpc/service-auth.js';

const legacySecret = 'test-user-grpc-secret-at-least-32-characters';
const pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicJwk = {
  ...pair.publicKey.export({ format: 'jwk' }),
  iss: 'wgo-post-service',
  kid: 'post-1',
  alg: 'ES256',
};
const keys = trustedKeys(JSON.stringify({ keys: [publicJwk] }));

function metadata(token?: string): Metadata {
  const value = new Metadata();
  if (token) value.add('authorization', `Bearer ${token}`);
  return value;
}

function esToken(
  header: Record<string, unknown> = {},
  claims: Record<string, unknown> = {},
  signer: KeyObject = pair.privateKey,
): string {
  const now = Math.floor(Date.now() / 1000);
  const encodedHeader = Buffer.from(
    JSON.stringify({
      alg: 'ES256',
      typ: 'wgo-service+jwt',
      kid: 'post-1',
      ...header,
    }),
  ).toString('base64url');
  const encodedPayload = Buffer.from(
    JSON.stringify({
      iss: 'wgo-post-service',
      sub: 'post-service',
      aud: 'wgo-user-service',
      iat: now,
      exp: now + 30,
      ...claims,
    }),
  ).toString('base64url');
  const signature = sign(
    'sha256',
    Buffer.from(`${encodedHeader}.${encodedPayload}`),
    { key: signer, dsaEncoding: 'ieee-p1363' },
  ).toString('base64url');
  return `${encodedHeader}.${encodedPayload}.${signature}`;
}

function hsToken(
  claims: Record<string, unknown> = {},
  secret = legacySecret,
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'wgo-post-service',
      sub: 'post-service',
      aud: 'wgo-user-service',
      iat: now,
      exp: now + 30,
      ...claims,
    }),
  ).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(`${header}.${payload}`)
    .digest('base64url');
  return `${header}.${payload}.${signature}`;
}

describe('User gRPC service authentication', () => {
  it('accepts a trusted Post ES256 token and a legacy HS256 token', () => {
    expect(serviceCaller(metadata(esToken()), keys, legacySecret)).toBe(
      'post-service',
    );
    expect(serviceCaller(metadata(hsToken()), keys, legacySecret)).toBe(
      'post-service',
    );
  });

  it('rejects missing, duplicate, invalidly signed, and untrusted-key tokens', () => {
    const duplicate = metadata(esToken());
    duplicate.add('authorization', `Bearer ${esToken()}`);
    const other = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const altered = esToken().split('.');
    altered[2] = `${altered[2]}a`;

    expect(serviceCaller(new Metadata(), keys, legacySecret)).toBeNull();
    expect(serviceCaller(duplicate, keys, legacySecret)).toBeNull();
    expect(
      serviceCaller(metadata(altered.join('.')), keys, legacySecret),
    ).toBeNull();
    expect(
      serviceCaller(
        metadata(esToken({}, {}, other.privateKey)),
        keys,
        legacySecret,
      ),
    ).toBeNull();
  });

  it('rejects invalid ES256 headers without falling back to HS256', () => {
    for (const token of [
      esToken({ alg: 'HS256' }),
      esToken({ alg: 'RS256' }),
      esToken({ typ: 'JWT' }),
      esToken({ kid: 'unknown' }),
      esToken({ kid: undefined }),
    ])
      expect(serviceCaller(metadata(token), keys, legacySecret)).toBeNull();
  });

  it('rejects invalid service claims', () => {
    const now = Math.floor(Date.now() / 1000);
    for (const token of [
      esToken({}, { iss: 'wgo-other-service' }),
      esToken({}, { sub: 'other-service' }),
      esToken({}, { aud: 'wgo-other-service' }),
      esToken({}, { exp: now - 1 }),
      esToken({}, { iat: now + 6 }),
      esToken({}, { exp: now + 61 }),
      esToken({}, { exp: now }),
    ])
      expect(serviceCaller(metadata(token), keys, legacySecret)).toBeNull();
  });

  it('validates trusted JWKS and supports multiple rotation keys', () => {
    expect(() => trustedKeys('{')).toThrow('Invalid USER_SERVICE_TRUSTED_JWKS');
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [{ ...publicJwk, d: 'private' }] })),
    ).toThrow('Invalid USER_SERVICE_TRUSTED_JWKS');
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [{ ...publicJwk, crv: 'P-384' }] })),
    ).toThrow('Invalid USER_SERVICE_TRUSTED_JWKS');
    expect(() =>
      trustedKeys(JSON.stringify({ keys: [publicJwk, publicJwk] })),
    ).toThrow('Invalid USER_SERVICE_TRUSTED_JWKS');

    const next = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    const nextJwk = {
      ...next.publicKey.export({ format: 'jwk' }),
      iss: 'wgo-post-service',
      kid: 'post-2',
      alg: 'ES256',
    };
    const rotated = trustedKeys(JSON.stringify({ keys: [publicJwk, nextJwk] }));
    expect(rotated).toHaveLength(2);
    expect(
      serviceCaller(
        metadata(esToken({ kid: 'post-2' }, {}, next.privateKey)),
        rotated,
        legacySecret,
      ),
    ).toBe('post-service');
  });
});
