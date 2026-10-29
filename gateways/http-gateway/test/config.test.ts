import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  it('loads local defaults', () => {
    process.env = {};

    const config = loadConfig();

    expect(config.port).toBe(8080);
    expect(config.services.post).toBe('http://127.0.0.1:3002');
    expect(config.rateLimit.redisUrl).toBe('redis://127.0.0.1:6379');
  });

  it('rejects an invalid service URL', () => {
    process.env.POST_SERVICE_URL = 'not-a-url';

    expect(() => loadConfig()).toThrow('POST_SERVICE_URL');
  });
  it('rejects partially configured User authentication', () => {
    process.env = { JWT_ACCESS_SECRET: 'configured-but-incomplete' };
    expect(() => loadConfig()).toThrow('JWT_ACCESS_ISSUER');
  });
});

it('accepts authenticated TLS Redis without accepting Redis upstreams', () => {
  process.env = {
    REDIS_URL: 'rediss://:encoded-password@cache.example:6379/0',
  };
  expect(loadConfig().rateLimit.redisUrl).toBe(process.env.REDIS_URL);
  process.env.POST_SERVICE_URL = 'rediss://cache.example:6379';
  expect(() => loadConfig()).toThrow('POST_SERVICE_URL');
});

it('rejects HTTP Redis URLs without exposing credentials', () => {
  process.env = { REDIS_URL: 'https://:do-not-print@cache.example' };
  expect(() => loadConfig()).toThrow('REDIS_URL');
  try {
    loadConfig();
  } catch (error) {
    expect(String(error)).not.toContain('do-not-print');
  }
});

it('allows staging documentation with production runtime only when explicitly enabled', () => {
  process.env = {
    NODE_ENV: 'production',
    DEPLOYMENT_ENV: 'staging',
    DOCS_ENABLED: 'true',
  };
  expect(loadConfig().docs.enabled).toBe(true);
  delete process.env.DOCS_ENABLED;
  expect(loadConfig().docs.enabled).toBe(false);
  process.env.DOCS_ENABLED = 'true';
  process.env.DEPLOYMENT_ENV = 'production';
  expect(loadConfig().docs.enabled).toBe(false);
});
