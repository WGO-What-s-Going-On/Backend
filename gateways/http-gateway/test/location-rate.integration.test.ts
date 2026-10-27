import Fastify from 'fastify';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('location IP rate limit', () => {
  const redisUrl = 'redis://127.0.0.1:6381/14';
  let redis: Redis;
  const upstream = Fastify();
  let app: Awaited<ReturnType<typeof buildApp>>;
  let forwarded = 0;

  beforeAll(async () => {
    redis = new Redis(redisUrl);
    await redis.flushdb();
    upstream.put('/api/v1/location', async () => {
      forwarded++;
      return { ok: true };
    });
    upstream.get('/api/v1/posts', async () => ({ ok: true }));
    const upstreamUrl = await upstream.listen({ host: '127.0.0.1', port: 0 });
    process.env.NODE_ENV = 'test';
    const config = loadConfig();
    app = await buildApp({
      logger: false,
      config: {
        ...config,
        rateLimit: { enabled: true, max: 100, windowMs: 60000, redisUrl },
        services: { ...config.services, map: upstreamUrl, post: upstreamUrl },
      },
    });
  });

  afterAll(async () => {
    await app?.close();
    await upstream.close();
    await redis.quit();
  });

  it('blocks the 61st update before Map but leaves other paths available', async () => {
    for (let i = 0; i < 60; i++) {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/location',
        payload: {},
      });
      expect(response.statusCode).toBe(200);
    }
    const blocked = await app.inject({
      method: 'PUT',
      url: '/api/v1/location',
      payload: {},
    });
    expect(blocked.statusCode).toBe(429);
    expect(Number(blocked.headers['retry-after'])).toBeGreaterThan(0);
    expect(forwarded).toBe(60);
    expect(
      (await app.inject({ method: 'GET', url: '/api/v1/posts' })).statusCode,
    ).toBe(200);
  });

  it('fails closed when the location limit check cannot reach Redis', async () => {
    const evalCall = vi
      .spyOn(Redis.prototype, 'eval')
      .mockRejectedValueOnce(new Error('Redis unavailable'));
    try {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/v1/location',
        payload: {},
      });
      expect(response.statusCode).toBe(503);
      expect(forwarded).toBe(60);
    } finally {
      evalCall.mockRestore();
    }
  });
});
