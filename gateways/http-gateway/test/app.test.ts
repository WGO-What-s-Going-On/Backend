import Fastify from 'fastify';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';

const apps: Array<{ close(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function testConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  process.env.NODE_ENV = 'test';
  process.env.RATE_LIMIT_ENABLED = 'false';
  process.env.LOG_PRETTY = 'false';
  const base = loadConfig();

  return {
    ...base,
    ...overrides,
    rateLimit: overrides.rateLimit ?? base.rateLimit,
    upstream: overrides.upstream ?? base.upstream,
    services: overrides.services ?? base.services,
  };
}

describe('HTTP gateway', () => {
  it('reports liveness without Redis', async () => {
    const app = await buildApp({ config: testConfig(), logger: false });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/live' });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ status: 'ok' });
    expect(response.headers['x-request-id']).toBeTypeOf('string');
  });

  it('returns the gateway not-found contract', async () => {
    const app = await buildApp({ config: testConfig(), logger: false });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/unknown' });

    expect(response.statusCode).toBe(404);
    expect(response.json()).toMatchObject({ code: 'GATEWAY_ROUTE_NOT_FOUND' });
  });

  it('proxies a post request path and preserves the downstream response', async () => {
    const upstream = Fastify();
    upstream.get('/api/v1/posts/nearby', async (request) => ({
      source: 'post-service',
      query: request.query,
      requestId: request.headers['x-request-id'] ?? null,
    }));
    const upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
    apps.push(upstream);

    const base = testConfig();
    const app = await buildApp({
      config: testConfig({ services: { ...base.services, post: upstreamUrl } }),
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/posts/nearby?lat=37.123&lng=127.123&radius=500',
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      source: 'post-service',
      query: { lat: '37.123', lng: '127.123', radius: '500' },
    });
    expect(response.json().requestId).toBeTypeOf('string');
  });

  it('maps an unavailable upstream to a gateway-owned 502 response', async () => {
    const base = testConfig();
    const app = await buildApp({
      config: testConfig({
        services: { ...base.services, post: 'http://127.0.0.1:9' },
      }),
      logger: false,
    });
    apps.push(app);

    const response = await app.inject({
      method: 'GET',
      url: '/api/v1/posts/nearby',
    });

    expect(response.statusCode).toBe(502);
    expect(response.json()).toMatchObject({
      code: 'GATEWAY_BAD_UPSTREAM',
      message: 'The gateway could not reach the upstream service.',
    });
  });
});
