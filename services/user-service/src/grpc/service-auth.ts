import {
  createHmac,
  createPublicKey,
  timingSafeEqual,
  verify,
  type KeyObject,
} from 'node:crypto';
import type { Metadata } from '@grpc/grpc-js';

export type TrustedKey = { issuer: string; kid: string; key: KeyObject };

function coordinate(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^[A-Za-z0-9_-]{43}$/.test(value) &&
    Buffer.from(value, 'base64url').toString('base64url') === value
  );
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid USER_SERVICE_TRUSTED_JWKS');
  return value as Record<string, unknown>;
}

export function trustedKeys(
  value = process.env.USER_SERVICE_TRUSTED_JWKS,
): TrustedKey[] {
  if (!value) throw new Error('USER_SERVICE_TRUSTED_JWKS is required');
  try {
    const jwks = object(JSON.parse(value));
    if (!Array.isArray(jwks.keys) || jwks.keys.length === 0) throw new Error();
    const keys = jwks.keys.map((entry: unknown) => {
      const jwk = object(entry);
      if (
        jwk.iss !== 'wgo-post-service' ||
        typeof jwk.kid !== 'string' ||
        !jwk.kid ||
        jwk.alg !== 'ES256' ||
        jwk.kty !== 'EC' ||
        jwk.crv !== 'P-256' ||
        !coordinate(jwk.x) ||
        !coordinate(jwk.y) ||
        'd' in jwk
      )
        throw new Error();
      return {
        issuer: jwk.iss,
        kid: jwk.kid,
        key: createPublicKey({ key: jwk as any, format: 'jwk' }),
      };
    });
    if (
      new Set(keys.map((key) => `${key.issuer}:${key.kid}`)).size !==
      keys.length
    )
      throw new Error();
    return keys;
  } catch {
    throw new Error('Invalid USER_SERVICE_TRUSTED_JWKS');
  }
}

export function serviceCaller(
  metadata: Metadata,
  keys: TrustedKey[],
  legacySecret = process.env.USER_SERVICE_JWT_SECRET,
): string | null {
  const values = metadata.get('authorization');
  if (values.length !== 1 || typeof values[0] !== 'string') return null;
  const token = /^Bearer (\S+)$/i.exec(values[0])?.[1];
  const parts = token?.split('.');
  if (!parts || parts.length !== 3) return null;
  try {
    const [encodedHeader, encodedPayload, encodedSignature] = parts as [
      string,
      string,
      string,
    ];
    const header = object(
      JSON.parse(Buffer.from(encodedHeader, 'base64url').toString()),
    );
    const payload = object(
      JSON.parse(Buffer.from(encodedPayload, 'base64url').toString()),
    );
    const signed = `${encodedHeader}.${encodedPayload}`;
    const signature = Buffer.from(encodedSignature, 'base64url');

    if (header.alg === 'ES256') {
      if (
        header.typ !== 'wgo-service+jwt' ||
        typeof header.kid !== 'string' ||
        !header.kid
      )
        return null;
      const key = keys.find(
        (entry) => entry.issuer === payload.iss && entry.kid === header.kid,
      );
      if (
        !key ||
        signature.length !== 64 ||
        !verify(
          'sha256',
          Buffer.from(signed),
          { key: key.key, dsaEncoding: 'ieee-p1363' },
          signature,
        )
      )
        return null;
    } else if (header.alg === 'HS256') {
      // Keep legacy callers working until the shared-secret rollout is removed.
      if (
        header.typ !== 'JWT' ||
        header.kid !== undefined ||
        !legacySecret ||
        legacySecret.length < 32
      )
        return null;
      const expected = createHmac('sha256', legacySecret)
        .update(signed)
        .digest();
      if (
        signature.length !== expected.length ||
        !timingSafeEqual(signature, expected)
      )
        return null;
    } else return null;

    const now = Math.floor(Date.now() / 1000);
    if (
      typeof payload.sub !== 'string' ||
      payload.iss !== `wgo-${payload.sub}` ||
      payload.aud !== 'wgo-user-service' ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      (payload.iat as number) < 0 ||
      (payload.iat as number) > now + 5 ||
      (payload.exp as number) <= now ||
      (payload.exp as number) <= (payload.iat as number) ||
      (payload.exp as number) - (payload.iat as number) > 60
    )
      return null;
    return payload.sub;
  } catch {
    return null;
  }
}
