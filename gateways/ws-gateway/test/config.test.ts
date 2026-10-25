import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  it('loads explicit user credentials with local transport defaults', () => {
    process.env = {
      NODE_ENV: 'test',
      JWT_ACCESS_SECRET: 'test-secret-that-is-at-least-32-bytes',
      JWT_ACCESS_ISSUER: 'wgo-user-service',
      JWT_ACCESS_AUDIENCE: 'wgo-api',
    };

    const config = loadConfig();

    expect(config.port).toBe(8081);
    expect(config.websocket.path).toBe('/ws/v1');
    expect(config.websocket.maxPayloadBytes).toBe(65_536);
  });

  it('requires explicit User credentials in production', () => {
    process.env = { NODE_ENV: 'production' };

    expect(() => loadConfig()).toThrow('JWT_ACCESS_SECRET');
  });

  it('starts production without JWKS while preserving service authentication requirements', () => {
    process.env = {
      NODE_ENV: 'production',
      JWT_ACCESS_SECRET: 'test-secret-that-is-at-least-32-bytes',
      JWT_ACCESS_ISSUER: 'wgo-user-service',
      JWT_ACCESS_AUDIENCE: 'wgo-api',
    };
    expect(() => loadConfig()).toThrow('WS_SERVICE_JWT_SECRET');
    process.env.WS_SERVICE_PRIVATE_JWK = 'validated-by-post-client';
    expect(loadConfig().jwt.audience).toBe('wgo-api');
  });

  it.each(['JWT_ACCESS_SECRET', 'JWT_ACCESS_ISSUER', 'JWT_ACCESS_AUDIENCE'])(
    'rejects missing %s locally too',
    (name) => {
      delete process.env[name];
      expect(() => loadConfig()).toThrow('JWT_ACCESS_');
    },
  );

  it('does not silently use legacy credentials', () => {
    process.env = {
      NODE_ENV: 'test',
      JWT_SECRET: 'legacy-secret-that-is-at-least-32-bytes',
      JWT_ISSUER: 'issuer',
      JWT_AUDIENCE: 'audience',
      JWT_JWKS_URL: 'https://unused.example/keys',
    };
    expect(() => loadConfig()).toThrow('JWT_ACCESS_SECRET');
  });

  it('rejects a heartbeat timeout longer than its interval', () => {
    process.env.NODE_ENV = 'test';
    process.env.WS_HEARTBEAT_INTERVAL_MS = '1000';
    process.env.WS_HEARTBEAT_TIMEOUT_MS = '1000';

    expect(() => loadConfig()).toThrow('WS_HEARTBEAT_TIMEOUT_MS');
  });
});
