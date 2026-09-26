import type { FastifyRequest } from 'fastify';
import { createRemoteJWKSet, jwtVerify } from 'jose';

import type { AppConfig } from '../config.js';

export interface AuthenticatedUser {
  userId: string;
}

export interface Authenticator {
  authenticate(request: FastifyRequest): Promise<AuthenticatedUser>;
}

export class AuthenticationError extends Error {}

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export class JwtAuthenticator implements Authenticator {
  readonly #key: Uint8Array | ReturnType<typeof createRemoteJWKSet>;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #cookieName: string;

  constructor(config: AppConfig['jwt']) {
    // 로컬은 공유 비밀값으로, 운영은 JWKS 공개키로 사용자 토큰을 검증한다.
    this.#key = config.jwksUrl
      ? createRemoteJWKSet(new URL(config.jwksUrl))
      : new TextEncoder().encode(config.secret);
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#cookieName = config.cookieName;
  }

  async authenticate(request: FastifyRequest): Promise<AuthenticatedUser> {
    const token =
      bearerToken(request.headers.authorization) ??
      request.cookies[this.#cookieName];

    if (!token)
      throw new AuthenticationError('A valid access token is required.');

    try {
      const { payload } =
        this.#key instanceof Uint8Array
          ? await jwtVerify(token, this.#key, {
              algorithms: ['HS256'],
              issuer: this.#issuer,
              audience: this.#audience,
            })
          : await jwtVerify(token, this.#key, {
              algorithms: ['RS256', 'ES256'],
              issuer: this.#issuer,
              audience: this.#audience,
            });

      if (typeof payload.sub !== 'string' || payload.sub.length === 0) {
        throw new AuthenticationError('The access token has no subject.');
      }

      return { userId: payload.sub };
    } catch (error) {
      if (error instanceof AuthenticationError) throw error;
      throw new AuthenticationError('The access token is invalid or expired.');
    }
  }
}
