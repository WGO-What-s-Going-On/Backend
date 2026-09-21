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

function bearerToken(header: string | undefined): string | undefined {
  if (!header) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(header);
  return match?.[1];
}

export class JwtAuthenticator implements Authenticator {
  readonly #secret: Uint8Array;
  readonly #issuer: string;
  readonly #audience: string;
  readonly #cookieName: string;

  constructor(config: AppConfig['jwt']) {
    this.#secret = new TextEncoder().encode(config.secret);
    this.#issuer = config.issuer;
    this.#audience = config.audience;
    this.#cookieName = config.cookieName;
  }

  async authenticate(request: FastifyRequest): Promise<AuthenticatedUser> {
    const token = bearerToken(request.headers.authorization)
      ?? request.cookies[this.#cookieName];

    if (!token) throw new AuthenticationError('A valid access token is required.');

    try {
      const { payload } = await jwtVerify(token, this.#secret, {
        algorithms: ['HS256'],
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
