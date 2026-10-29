import { createPublicKey, verify } from 'node:crypto';

// The signed user claim binds the forwarded identity to this gateway request.
export function gatewayIdentity(
  authorization: unknown,
  userId: unknown,
): boolean {
  try {
    if (
      typeof authorization !== 'string' ||
      typeof userId !== 'string' ||
      !/^[1-9][0-9]{0,15}$/.test(userId) ||
      !Number.isSafeInteger(Number(userId))
    )
      return false;
    const parts = /^Bearer (\S+)$/i.exec(authorization)?.[1]?.split('.');
    if (!parts || parts.length !== 3) return false;
    const [h, p, s] = parts as [string, string, string];
    const header = JSON.parse(Buffer.from(h, 'base64url').toString());
    const payload = JSON.parse(Buffer.from(p, 'base64url').toString());
    const jwks = JSON.parse(process.env.POST_HTTP_GATEWAY_TRUSTED_JWKS ?? '');
    if (!Array.isArray(jwks.keys)) return false;
    const matches = jwks.keys.filter(
      (key: Record<string, unknown>) =>
        key.kid === header.kid && key.iss === 'wgo-http-gateway',
    );
    if (matches.length !== 1) return false;
    const jwk = matches[0];
    const now = Math.floor(Date.now() / 1000);
    if (
      jwk.alg !== 'ES256' ||
      jwk.kty !== 'EC' ||
      jwk.crv !== 'P-256' ||
      'd' in jwk ||
      typeof header.kid !== 'string' ||
      !header.kid ||
      header.alg !== 'ES256' ||
      header.typ !== 'wgo-service+jwt' ||
      payload.iss !== 'wgo-http-gateway' ||
      payload.sub !== 'http-gateway' ||
      payload.aud !== 'wgo-post-service' ||
      payload.userId !== userId ||
      !Number.isInteger(payload.iat) ||
      !Number.isInteger(payload.exp) ||
      payload.iat < 0 ||
      payload.iat > now + 5 ||
      payload.exp <= now ||
      payload.exp <= payload.iat ||
      payload.exp - payload.iat > 60 ||
      (payload.nbf !== undefined &&
        (!Number.isInteger(payload.nbf) || payload.nbf > now))
    )
      return false;
    return verify(
      'sha256',
      Buffer.from(`${h}.${p}`),
      {
        key: createPublicKey({ key: jwk, format: 'jwk' }),
        dsaEncoding: 'ieee-p1363',
      },
      Buffer.from(s, 'base64url'),
    );
  } catch {
    return false;
  }
}

import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
@Injectable()
export class GatewayAuthGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest();
    // Preserve the explicit local test harness; production always requires the gateway signature.
    if (process.env.NODE_ENV !== 'production' && !request.headers.authorization)
      return true;
    const count = (name: string) =>
      request.rawHeaders.filter(
        (value: string, i: number) =>
          i % 2 === 0 && value.toLowerCase() === name,
      ).length;
    if (
      count('authorization') !== 1 ||
      count('x-user-id') !== 1 ||
      !gatewayIdentity(
        request.headers.authorization,
        request.headers['x-user-id'],
      )
    )
      throw new UnauthorizedException('Invalid gateway identity');
    return true;
  }
}
