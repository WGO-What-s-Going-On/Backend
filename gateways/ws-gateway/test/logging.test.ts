import Fastify from 'fastify';
import { Writable } from 'node:stream';
import { describe, expect, it } from 'vitest';
import {
  loggingOptions,
  registerRequestLogging,
  requestFailure,
  gatewayContext,
} from '../src/logging.js';

describe('structured request logging', () => {
  it('records one outcome with auth reason and excludes headers, query and exception secrets', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const app = Fastify({
      logger: { ...loggingOptions('gateway-test', 'info'), stream },
      disableRequestLogging: true,
    });
    registerRequestLogging(app);
    app.get('/api/v1/posts/:postId/vote', async (request, reply) => {
      requestFailure(
        request,
        'AUTH_TOKEN_EXPIRED',
        'Access token expired.',
        new Error('secret-private-error'),
      );
      return reply.code(401).send({ code: 'GATEWAY_UNAUTHORIZED' });
    });
    try {
      const response = await app.inject({
        url: '/api/v1/posts/post-test/vote?ticket=private-query',
        headers: {
          authorization: 'Bearer private-token',
          cookie: 'secret-cookie',
          'x-correlation-id': 'ranking-request',
        },
      });
      expect(response.statusCode).toBe(401);
      expect(lines).toHaveLength(1);
      const entry = JSON.parse(lines[0]!);
      expect(entry).toMatchObject({
        severity: 'WARNING',
        service: 'gateway-test',
        domain: 'vote',
        outcome: 'failure',
        statusCode: 401,
        correlationId: 'ranking-request',
        error: { code: 'AUTH_TOKEN_EXPIRED', message: 'Access token expired.' },
      });
      expect(entry.timestamp).toBeTypeOf('string');
      expect(lines.join('')).not.toMatch(
        /private-query|private-token|secret-cookie|secret-private-error/,
      );
    } finally {
      await app.close();
    }
  });
  it('keeps request context isolated and suppresses successful probes', async () => {
    const lines: string[] = [];
    const stream = new Writable({
      write(chunk, _encoding, callback) {
        lines.push(String(chunk));
        callback();
      },
    });
    const app = Fastify({
      logger: { ...loggingOptions('gateway-test', 'info'), stream },
      disableRequestLogging: true,
    });
    registerRequestLogging(app);
    app.get('/health/live', async () => ({ ok: true }));
    app.get('/api/v1/posts', async (request) => {
      await Promise.resolve();
      return gatewayContext(request);
    });
    try {
      await app.inject('/health/live');
      expect(lines).toHaveLength(0);
      const responses = await Promise.all(
        ['first', 'second'].map((id) =>
          app.inject({
            url: '/api/v1/posts',
            headers: { 'x-correlation-id': id },
          }),
        ),
      );
      expect(
        responses.map((response) => response.json().correlationId),
      ).toEqual(['first', 'second']);
      expect(
        lines.map((line) => JSON.parse(line).correlationId).sort(),
      ).toEqual(['first', 'second']);
    } finally {
      await app.close();
    }
  });
});
