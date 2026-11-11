import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import type { FastifyInstance } from 'fastify';
import { verifyAccessToken, type UserAuthConfig } from './user-auth.js';
import { requestFailure } from './logging.js';

export function registerRealtimeTickets(
  app: FastifyInstance,
  config: UserAuthConfig | null,
) {
  app.post('/api/v1/realtime/tickets', async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const fail = (status: number, code: string, message: string) =>
      reply.code(status).send({
        code,
        message,
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });
    if (!config)
      return fail(
        503,
        'GATEWAY_UPSTREAM_UNAVAILABLE',
        'User authentication is not configured.',
      );
    let user;
    try {
      user = await verifyAccessToken(request, config);
    } catch (error) {
      requestFailure(
        request,
        'AUTH_TOKEN_INVALID',
        'Ticket authentication failed.',
        error,
      );
      return fail(
        401,
        'GATEWAY_UNAUTHORIZED',
        'Invalid authentication credentials.',
      );
    }
    const now = Math.floor(Date.now() / 1000);
    // 티켓이 원래 Access JWT보다 오래 살아남아서는 안 된다.
    const expires = Math.min(now + 45, user.expiresAt);
    if (expires <= now)
      return fail(401, 'GATEWAY_UNAUTHORIZED', 'Access token expired.');
    const ticket = await new SignJWT({ sid: user.sessionId })
      .setProtectedHeader({ alg: 'HS256', typ: 'wgo-ws-ticket+jwt' })
      .setIssuer('wgo-http-gateway')
      .setAudience('wgo-ws-gateway')
      .setSubject(user.userId)
      .setJti(randomUUID())
      .setIssuedAt(now)
      .setExpirationTime(expires)
      .sign(new TextEncoder().encode(config.accessSecret));
    return reply
      .code(201)
      .send({ ticket, expiresAt: new Date(expires * 1000).toISOString() });
  });
}
