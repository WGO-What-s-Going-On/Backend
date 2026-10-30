import {
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { createPublicKey, type KeyObject } from 'node:crypto';
import { jwtVerify, decodeProtectedHeader } from 'jose';
import { parseUserId } from '../user-id.js';

const operations: Record<string, 'public' | 'user'> = {
  'POST /api/v1/auth/kakao': 'public',
  'POST /api/v1/auth/refresh': 'public',
  'POST /api/v1/auth/logout': 'user',
  'GET /api/v1/users/nickname/availability': 'public',
  'GET /api/v1/terms': 'public',
  'GET /api/v1/users/me/blocks': 'user',
  'PUT /api/v1/users/me/blocks': 'user',
  'DELETE /api/v1/users/me/blocks': 'user',
  'GET /api/v1/users/me': 'user',
  'PATCH /api/v1/users/me': 'user',
  'POST /api/v1/users/me/term-consents': 'user',
  'GET /api/v1/users/me/badges': 'user',
  'GET /api/v1/users/me/credits': 'user',
  'GET /api/v1/users/me/growth': 'user',
  'GET /api/v1/users/me/credits/history': 'user',
  'GET /api/v1/users/me/badges/history': 'user',
  'POST /api/v1/users/me/withdrawal': 'user',
};

type Request = {
  method: string;
  path: string;
  headers: Record<string, unknown>;
  rawHeaders: string[];
};

@Injectable()
export class GatewayAuthGuard implements CanActivate {
  private readonly keys: Map<string, KeyObject>;

  constructor() {
    try {
      const jwks = JSON.parse(process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS ?? '');
      if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error();
      this.keys = new Map();
      for (const jwk of jwks.keys) {
        if (
          jwk.iss !== 'wgo-http-gateway' ||
          jwk.alg !== 'ES256' ||
          jwk.kty !== 'EC' ||
          jwk.crv !== 'P-256' ||
          typeof jwk.kid !== 'string' ||
          !jwk.kid ||
          this.keys.has(jwk.kid) ||
          'd' in jwk ||
          typeof jwk.x !== 'string' ||
          typeof jwk.y !== 'string'
        )
          throw new Error();
        // Parse public keys at startup so invalid configuration cannot leave a partially serving app.
        const key = createPublicKey({ key: jwk, format: 'jwk' });
        this.keys.set(jwk.kid, key);
      }
    } catch {
      throw new Error('Invalid or missing USER_HTTP_GATEWAY_TRUSTED_JWKS');
    }
  }

  async canActivate(context: ExecutionContext): Promise<boolean> {
    if (context.getType() !== 'http') return true;
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET' && request.path === '/health/live')
      return true;
    try {
      const count = (name: string) =>
        request.rawHeaders.filter(
          (value, i) => i % 2 === 0 && value.toLowerCase() === name,
        ).length;
      const token =
        typeof request.headers.authorization === 'string'
          ? /^Bearer (\S+)$/i.exec(request.headers.authorization)?.[1]
          : undefined;
      if (!token || count('authorization') !== 1) throw new Error();
      const header = decodeProtectedHeader(token);
      const key =
        typeof header.kid === 'string' ? this.keys.get(header.kid) : undefined;
      if (!key) throw new Error();
      const { payload } = await jwtVerify(token, key, {
        algorithms: ['ES256'],
        typ: 'wgo-service+jwt',
        issuer: 'wgo-http-gateway',
        subject: 'http-gateway',
        audience: 'wgo-user-service',
        requiredClaims: ['iat', 'exp'],
      });
      const now = Math.floor(Date.now() / 1000);
      if (
        payload.aud !== 'wgo-user-service' ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat! < 0 ||
        payload.iat! > now + 5 ||
        payload.exp! <= payload.iat! ||
        payload.exp! - payload.iat! > 60
      )
        throw new Error();
      const policy = operations[`${request.method} ${request.path}`];
      if (!policy) throw new ForbiddenException('Operation not permitted');
      if (policy === 'user') {
        if (
          count('x-user-id') !== 1 ||
          !parseUserId(request.headers['x-user-id'])
        )
          throw new Error();
        if (
          request.path === '/api/v1/auth/logout' &&
          (count('x-session-id') !== 1 ||
            typeof request.headers['x-session-id'] !== 'string' ||
            !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
              request.headers['x-session-id'],
            ))
        )
          throw new Error();
      } else {
        // Public operations never receive a user identity from unverified input.
        delete request.headers['x-user-id'];
        delete request.headers['x-session-id'];
      }
      return true;
    } catch (error) {
      if (error instanceof ForbiddenException) throw error;
      throw new UnauthorizedException('Invalid authentication credentials');
    }
  }
}
