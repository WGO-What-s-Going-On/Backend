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
