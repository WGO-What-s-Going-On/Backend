import { randomUUID } from 'node:crypto';

import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import httpProxy from '@fastify/http-proxy';
import rateLimit from '@fastify/rate-limit';
import Fastify, { type FastifyInstance } from 'fastify';
import { Redis } from 'ioredis';

import { loadConfig, type AppConfig } from './config.js';
import { proxyRoutes } from './routes.js';

export interface BuildAppOptions {
  config?: AppConfig;
  logger?: boolean;
}

function errorCode(statusCode: number, fastifyCode?: string): string {
  if (fastifyCode === 'FST_ERR_CTP_BODY_TOO_LARGE') return 'GATEWAY_PAYLOAD_TOO_LARGE';
  if (statusCode === 400) return 'GATEWAY_BAD_REQUEST';
  if (statusCode === 429) return 'GATEWAY_RATE_LIMITED';
  if (statusCode === 502) return 'GATEWAY_BAD_UPSTREAM';
  if (statusCode === 503) return 'GATEWAY_UPSTREAM_UNAVAILABLE';
  if (statusCode === 504) return 'GATEWAY_TIMEOUT';
  return 'GATEWAY_INTERNAL_ERROR';
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const config = options.config ?? loadConfig();
  const logger = options.logger === false
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
  }

  app.get('/health/live', { config: { rateLimit: false } }, async () => ({
    status: 'ok',
  }));

  app.get('/health/ready', { config: { rateLimit: false } }, async (_request, reply) => {
    if (!redis) return { status: 'ready', redis: 'disabled' };

    try {
      await redis.ping();
      return { status: 'ready', redis: 'up' };
    } catch {
      return reply.code(503).send({ status: 'not-ready', redis: 'down' });
    }
  });

  app.setNotFoundHandler(async (request, reply) => reply.code(404).send({
    code: 'GATEWAY_ROUTE_NOT_FOUND',
    message: 'No gateway route matches this request.',
    requestId: request.id,
    timestamp: new Date().toISOString(),
  }));

  app.setErrorHandler<Error & { statusCode?: number; code?: string }>(async (error, request, reply) => {
    const statusCode = error.statusCode && error.statusCode >= 400
      ? error.statusCode
      : 500;

    request.log.error({ err: error, statusCode }, 'gateway request failed');

    return reply.code(statusCode).send({
      code: errorCode(statusCode, error.code),
      message: statusCode >= 500 ? 'The gateway could not complete the request.' : error.message,
      requestId: request.id,
      timestamp: new Date().toISOString(),
    });
  });

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
          const statusCode = timeoutCodes.has((error as NodeJS.ErrnoException).code ?? '') ? 504 : 502;

          reply.request.log.error({ err: error, upstream: route.service }, 'upstream request failed');
          reply.code(statusCode).send({
            code: statusCode === 504 ? 'GATEWAY_TIMEOUT' : 'GATEWAY_BAD_UPSTREAM',
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
