import { afterEach, describe, expect, it } from 'vitest';

import { loadConfig } from '../src/config.js';

const originalEnv = { ...process.env };

afterEach(() => {
  process.env = { ...originalEnv };
});

describe('loadConfig', () => {
  it('loads safe local defaults', () => {
    process.env = { NODE_ENV: 'test' };

    const config = loadConfig();

    expect(config.port).toBe(8081);
    expect(config.websocket.path).toBe('/ws/v1');
    expect(config.websocket.maxPayloadBytes).toBe(65_536);
  });

  it('requires an explicit JWT secret in production', () => {
    process.env = { NODE_ENV: 'production' };

    expect(() => loadConfig()).toThrow('JWT_SECRET');
  });

  it('rejects a heartbeat timeout longer than its interval', () => {
    process.env.NODE_ENV = 'test';
    process.env.WS_HEARTBEAT_INTERVAL_MS = '1000';
    process.env.WS_HEARTBEAT_TIMEOUT_MS = '1000';

    expect(() => loadConfig()).toThrow('WS_HEARTBEAT_TIMEOUT_MS');
  });
});
