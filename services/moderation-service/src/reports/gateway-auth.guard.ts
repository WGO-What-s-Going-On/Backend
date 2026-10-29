import {
  Injectable,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { decodeProtectedHeader, jwtVerify } from 'jose';

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  private readonly keys = new Map<string, KeyObject>();
  constructor() {
    const raw = process.env.MODERATION_HTTP_GATEWAY_TRUSTED_JWKS;
    // Missing infrastructure keeps report routes closed in every environment.
    // The existing Lifecycle/AI workers can still run independently.
    if (!raw) return;
    try {
      const jwks = JSON.parse(raw);
      if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error();
      for (const jwk of jwks.keys) {
        if (
          jwk.iss !== 'wgo-http-gateway' ||
          jwk.alg !== 'ES256' ||
          jwk.kty !== 'EC' ||
          jwk.crv !== 'P-256' ||
          typeof jwk.kid !== 'string' ||
          !jwk.kid ||
          this.keys.has(jwk.kid) ||
          'd' in jwk
        )
          throw new Error();
        this.keys.set(jwk.kid, createPublicKey({ key: jwk, format: 'jwk' }));
      }
    } catch {
      throw new Error('Invalid MODERATION_HTTP_GATEWAY_TRUSTED_JWKS');
    }
  }
  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<{
      headers: Record<string, unknown>;
      rawHeaders: string[];
    }>();
    try {
      const count = (name: string) =>
        request.rawHeaders.filter(
          (value, i) => i % 2 === 0 && value.toLowerCase() === name,
        ).length;
      const userId = request.headers['x-user-id'];
      const token =
        typeof request.headers.authorization === 'string'
          ? /^Bearer (\S+)$/i.exec(request.headers.authorization)?.[1]
          : undefined;
      if (
        !token ||
        count('authorization') !== 1 ||
        count('x-user-id') !== 1 ||
        typeof userId !== 'string' ||
        !/^[1-9][0-9]{0,15}$/.test(userId) ||
        BigInt(userId) > 9007199254740991n
      )
        throw new Error();
      const header = decodeProtectedHeader(token);
      const key =
        typeof header.kid === 'string' ? this.keys.get(header.kid) : undefined;
      if (!key) throw new Error();
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['ES256'],
        typ: 'wgo-service+jwt',
        issuer: 'wgo-http-gateway',
        subject: 'http-gateway',
        audience: 'wgo-moderation-service',
        requiredClaims: ['iat', 'exp'],
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        payload.aud !== 'wgo-moderation-service' ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat! < 0 ||
        payload.iat! > now + 5 ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 60
      )
        throw new Error();
      return true;
    } catch {
      throw new UnauthorizedException('Invalid Gateway authentication');
    }
  }
}
