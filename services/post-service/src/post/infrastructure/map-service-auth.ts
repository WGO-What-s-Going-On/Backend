import { createPrivateKey, createPublicKey, sign } from 'node:crypto';
import { Metadata } from '@grpc/grpc-js';
import { ParticipationUnavailableError } from '../application/errors.js';

export function mapMetadata(): Metadata {
  let key: ReturnType<typeof createPrivateKey>;
  let kid: string;
  try {
    const jwk = JSON.parse(
      process.env.POST_SERVICE_SIGNING_JWK ?? '',
    ) as Record<string, unknown>;
    if (
      !jwk ||
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      jwk.alg !== 'ES256' ||
      typeof jwk.kid !== 'string' ||
      !jwk.kid ||
      !['x', 'y', 'd'].every(
        (field) =>
          typeof jwk[field] === 'string' &&
          /^[A-Za-z0-9_-]{43}$/.test(jwk[field] as string) &&
          Buffer.from(jwk[field] as string, 'base64url').toString(
            'base64url',
          ) === jwk[field],
      )
    )
      throw new Error();
    key = createPrivateKey({ key: jwk as any, format: 'jwk' });
    const publicJwk = createPublicKey(key).export({ format: 'jwk' });
    if (publicJwk.x !== jwk.x || publicJwk.y !== jwk.y) throw new Error();
    kid = jwk.kid;
  } catch {
    throw new ParticipationUnavailableError(
      'Map service authentication is not configured',
    );
  }
  const now = Math.floor(Date.now() / 1000);
  const header = Buffer.from(
    JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid }),
  ).toString('base64url');
  const payload = Buffer.from(
    JSON.stringify({
      iss: 'wgo-post-service',
      aud: 'wgo-map-service',
      sub: 'post-service',
      iat: now,
      exp: now + 30,
    }),
  ).toString('base64url');
  const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
    key,
    dsaEncoding: 'ieee-p1363',
  }).toString('base64url');
  const metadata = new Metadata();
  metadata.set('authorization', `Bearer ${header}.${payload}.${signature}`);
  return metadata;
}

export function mapDeadline(): Date {
  const timeout = Number(process.env.MAP_GRPC_TIMEOUT_MS ?? 500);
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > 10000)
    throw new ParticipationUnavailableError('Invalid Map deadline');
  return new Date(Date.now() + timeout);
}
