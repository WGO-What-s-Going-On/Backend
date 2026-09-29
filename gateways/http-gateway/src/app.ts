import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import httpProxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

import { loadConfig, type AppConfig } from './config.js';
import { proxyRoutes } from './routes.js';

const locationWindowScript = `
local key = KEYS[1]
local now = redis.call('TIME')
local now_ms = now[1] * 1000 + math.floor(now[2] / 1000)
redis.call('ZREMRANGEBYSCORE', key, '-inf', now_ms - 60000)
if redis.call('ZCARD', key) >= 60 then
  local oldest = redis.call('ZRANGE', key, 0, 0, 'WITHSCORES')
  return math.max(1, math.ceil((oldest[2] + 60000 - now_ms) / 1000))
end
redis.call('ZADD', key, now_ms, ARGV[1])
redis.call('PEXPIRE', key, 60000)
return 0
`;

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
}

function errorCode(statusCode: number, fastifyCode?: string): string {
  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE')
    return 'GATEWAY_PAYLOAD_TOO_LARGE';
  if (statusCode === 400) return 'GATEWAY_BAD_REQUEST';
  if (statusCode === 429) return 'GATEWAY_RATE_LIMITED';
  if (statusCode === 502) return 'GATEWAY_BAD_UPSTREAM';
  if (statusCode === 503) return 'GATEWAY_UPSTREAM_UNAVAILABLE';
  if (statusCode === 504) return 'GATEWAY_TIMEOUT';
  return 'GATEWAY_INTERNAL_ERROR';
}

export async function buildApp(
  options: BuildAppOptions = {},
): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const logger =
    options.logger === false
      ? false
      : config.logPretty
        ? {
            level: config.logLevel,
            transport: {
              target: 'pino-pretty',
              options: { colorize: true, translateTime: 'SYS:standard' },
            },
          }
        : { level: config.logLevel };

  const app = Fastify({
    logger,
    bodyLimit: config.bodyLimitBytes,
    trustProxy: false,
    requestIdHeader: false,
    genReqId: () => randomUUID(),
  });

  app.addHook('onSend', async (request, reply) => {
    reply.header('x-request-id', request.id);
  });

  await app.register(cors, {
    origin: config.corsOrigins,
    credentials: true,
  });
  await app.register(helmet);

  let redis: Redis | undefined;
  if (config.rateLimit.enabled) {
    redis = new Redis(config.rateLimit.redisUrl, {
      lazyConnect: true,
      connectTimeout: 1_000,
      maxRetriesPerRequest: 1,
      enableOfflineQueue: false,
    });

    await redis.connect();
    await redis.ping();

    await app.register(rateLimit, {
      global: true,
      redis,
      max: config.rateLimit.max,
      timeWindow: config.rateLimit.windowMs,
      keyGenerator: (request) => request.ip,
    });

    app.addHook('onClose', async () => {
      if (redis?.status === 'ready') await redis.quit();
      else redis?.disconnect();
    });

    app.addHook('preHandler', async (request, reply) => {
      if (
        request.method !== 'PUT' ||
        request.url.split('?')[0] !== '/api/v1/location'
      )
        return;
      try {
        // The Redis script makes the sliding window atomic across gateway instances.
        const retryAfter = Number(
          await redis!.eval(
            locationWindowScript,
            1,
            `gateway:location:ip:${request.ip}`,
            randomUUID(),
          ),
        );
        if (retryAfter > 0)
          return reply.header('Retry-After', retryAfter).code(429).send({
            code: 'GATEWAY_RATE_LIMITED',
            message: 'Too many location updates.',
            requestId: request.id,
            timestamp: new Date().toISOString(),
          });
      } catch {
        // Location writes must stop when the shared limit cannot be checked.
        return reply.code(503).send({
          code: 'GATEWAY_UPSTREAM_UNAVAILABLE',
          message: 'Location rate limit unavailable.',
          requestId: request.id,
          timestamp: new Date().toISOString(),
        });
      }
    });
  }

  app.get('/health/live', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
  }));

  app.get(
    '/health/ready',
    { config: { rateLimit: false } },
    async (_request, reply) => {
      if (!redis) return { status: 'ready', redis: 'disabled' };

      try {
        await redis.ping();
        return { status: 'ready', redis: 'up' };
      } catch {
        return reply.code(503).send({ status: 'not-ready', redis: 'down' });
      }
    },
  );

  app.setNotFoundHandler(async (request, reply) =>
    reply.code(404).send({
      code: 'GATEWAY_ROUTE_NOT_FOUND',
      message: 'No gateway route matches this request.',
      requestId: request.id,
      timestamp: new Date().toISOString(),
    }),
  );

  app.setErrorHandler<Error & { statusCode?: number; code?: string }>(
    async (error, request, reply) => {
      const statusCode =
        error.statusCode && error.statusCode >= 400 ? error.statusCode : 500;

      request.log.error({ err: error, statusCode }, 'gateway request failed');

      return reply.code(statusCode).send({
        code: errorCode(statusCode, error.code),
        message:
          statusCode >= 500
            ? 'The gateway could not complete the request.'
            : error.message,
        requestId: request.id,
        timestamp: new Date().toISOString(),
      });
    },
  );

  for (const route of proxyRoutes) {
    await app.register(httpProxy, {
      upstream: config.services[route.service],
      prefix: route.prefix,
      rewritePrefix: route.prefix,
      http2: false,
      retryMethods: ['GET', 'HEAD'],
      maxRetriesOn503: config.upstream.maxRetries,
      replyOptions: {
        timeout: config.upstream.requestTimeoutMs,
        rewriteRequestHeaders: (request, headers) => ({
          ...headers,
          'x-request-id': request.id,
        }),
        onError: (reply, { error }) => {
          const timeoutCodes = new Set([
            'UND_ERR_BODY_TIMEOUT',
            'UND_ERR_CONNECT_TIMEOUT',
            'UND_ERR_HEADERS_TIMEOUT',
          ]);
          const statusCode = timeoutCodes.has(
            (error as NodeJS.ErrnoException).code ?? '',
          )
            ? 504
            : 502;

          reply.request.log.error(
            { err: error, upstream: route.service },
            'upstream request failed',
          );
          reply.code(statusCode).send({
            code:
              statusCode === 504 ? 'GATEWAY_TIMEOUT' : 'GATEWAY_BAD_UPSTREAM',
            message: 'The gateway could not reach the upstream service.',
            requestId: reply.request.id,
            timestamp: new Date().toISOString(),
          });
        },
      },
      undici: {
        connections: 100,
        connect: {
          timeout: config.upstream.requestTimeoutMs,
        },
        headersTimeout: config.upstream.requestTimeoutMs,
        bodyTimeout: config.upstream.requestTimeoutMs,
      },
    });
  }

  return app;
}
