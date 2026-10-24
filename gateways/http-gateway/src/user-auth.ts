import { importJWK, jwtVerify, SignJWT } from 'jose';
import type { FastifyReply, FastifyRequest } from 'fastify';

export interface UserAuthConfig {
  accessSecret: string;
  issuer: string;
  audience: string;
  servicePrivateJwk: string;
}

// Exact operations prevent newly added User endpoints from becoming public implicitly.
export const userOperations: Record<string, 'public' | 'user'> = {
  'POST /api/v1/auth/kakao': 'public',
  'POST /api/v1/auth/refresh': 'public',
  'POST /api/v1/auth/logout': 'user',
  'GET /api/v1/users/nickname/availability': 'public',
  'GET /api/v1/terms': 'public',
  'GET /api/v1/users/me': 'user',
  'PATCH /api/v1/users/me': 'user',
  'POST /api/v1/users/me/term-consents': 'user',
  'GET /api/v1/users/me/badges': 'user',
  'POST /api/v1/users/me/withdrawal': 'user',
};

export async function userAuthentication(config: UserAuthConfig | null) {
  let signingKey;
  let kid: string | undefined;
  if (config) {
    if (
      Buffer.byteLength(config.accessSecret) < 32 ||
      !config.issuer.trim() ||
      !config.audience.trim()
    )
      throw new Error('Invalid Gateway user JWT configuration');
    try {
      const jwk = JSON.parse(config.servicePrivateJwk);
      if (
        jwk.kty !== 'EC' ||
        jwk.crv !== 'P-256' ||
        jwk.alg !== 'ES256' ||
        typeof jwk.d !== 'string' ||
        typeof jwk.kid !== 'string' ||
        !jwk.kid
      )
        throw new Error();
      kid = jwk.kid;
      signingKey = await importJWK(jwk, 'ES256');
    } catch {
      throw new Error('Invalid HTTP_GATEWAY_SERVICE_PRIVATE_JWK');
    }
  }
  const key = signingKey;
  return async (request: FastifyRequest, reply: FastifyReply) => {
    const fail = (status: number, code: string, message: string) =>
      reply.code(status).send({
        code,
        message,
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });
    const policy =
      userOperations[`${request.method} ${request.url.split('?')[0]}`];
    if (!policy)
      return fail(
        404,
        'GATEWAY_ROUTE_NOT_FOUND',
        'No gateway route matches this request.',
      );
    if (!config || !key || !kid)
      return fail(
        503,
        'GATEWAY_UPSTREAM_UNAVAILABLE',
        'User authentication is not configured.',
      );

    // Never forward client-selected identity, even on login/refresh/public operations.
    delete request.headers['x-user-id'];
    delete request.headers['x-session-id'];
    if (policy === 'user') {
      try {
        const count = request.raw.rawHeaders.filter(
          (_, i, all) =>
            i % 2 === 0 && all[i]?.toLowerCase() === 'authorization',
        ).length;
        const token =
          typeof request.headers.authorization === 'string'
            ? /^Bearer (\S+)$/i.exec(request.headers.authorization)?.[1]
            : undefined;
        if (!token || count !== 1) throw new Error();
        const { payload } = await jwtVerify(
          token,
          new TextEncoder().encode(config.accessSecret),
          {
            algorithms: ['HS256'],
            issuer: config.issuer,
            audience: config.audience,
            typ: 'JWT',
            requiredClaims: ['sub', 'sid', 'iat', 'exp'],
          },
        );
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
          throw new Error();
        request.headers['x-user-id'] = payload.sub;
        request.headers['x-session-id'] = payload.sid;
      } catch {
        return fail(
          401,
          'GATEWAY_UNAUTHORIZED',
          'Invalid authentication credentials.',
        );
      }
    }
    // The upstream bearer proves Gateway identity; user identity stays in verified headers.
    request.headers.authorization = `Bearer ${await new SignJWT({})
      .setProtectedHeader({ alg: 'ES256', typ: 'wgo-service+jwt', kid })
      .setIssuer('wgo-http-gateway')
      .setSubject('http-gateway')
      .setAudience('wgo-user-service')
      .setIssuedAt()
      .setExpirationTime('30s')
      .sign(key)}`;
  };
}
