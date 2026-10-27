import type { FastifyRequest } from 'fastify';
import { jwtVerify } from 'jose';

import type { AppConfig } from '../config.js';

export interface AuthenticatedUser {
  userId: string;
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<AuthenticatedUser>;
}

export class AuthenticationError extends Error {}

export class JwtAuthenticator implements Authenticator {
  readonly #key: Uint8Array;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #cookieName: string;

  constructor(config: AppConfig['jwt']) {
    if (
      !config.secret.trim() ||
      Buffer.byteLength(config.secret) < 32 ||
      !config.issuer.trim() ||
      !config.audience.trim()
    )
      throw new Error('Invalid User Access JWT configuration');
    this.#key = new TextEncoder().encode(config.secret);
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#cookieName = config.cookieName;
  }

  async authenticate(request: FastifyRequest): Promise<AuthenticatedUser> {
    try {
      const header = request.headers.authorization;
      const count = request.raw.rawHeaders.filter(
        (value, i) => i % 2 === 0 && value.toLowerCase() === 'authorization',
      ).length;
      // 명시한 헤더가 잘못됐으면 쿠키로 우회하지 않는다. 브라우저는 헤더 없이 쿠키를 사용한다.
      const token =
        header !== undefined
          ? count === 1 && typeof header === 'string'
            ? /^Bearer (\S+)$/i.exec(header)?.[1]
            : undefined
          : count === 0
            ? request.cookies[this.#cookieName]
            : undefined;
      if (!token)
        throw new AuthenticationError('A valid access token is required.');
      const { payload } = await jwtVerify(token, this.#key, {
        algorithms: ['HS256'],
        issuer: this.#issuer,
        audience: this.#audience,
        typ: 'JWT',
        requiredClaims: ['sub', 'sid', 'iat', 'exp'],
      });
      // HTTP Gateway의 사용자 ID·세션 ID·시각 계약과 일치시킨다.
      if (
        typeof payload.sub !== 'string' ||
        !/^[1-9][0-9]{0,15}$/.test(payload.sub) ||
        BigInt(payload.sub) > 9007199254740991n ||
        typeof payload.sid !== 'string' ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
          payload.sid,
        ) ||
        !Number.isInteger(payload.iat) ||
        !Number.isInteger(payload.exp) ||
        payload.iat! < 0 ||
        payload.iat! > Math.floor(Date.now() / 1000) + 5 ||
        payload.exp! <= payload.iat!
      )
        throw new AuthenticationError('The access token has invalid claims.');

      return { userId: payload.sub };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('The access token is invalid or expired.');
    }
  }
}
