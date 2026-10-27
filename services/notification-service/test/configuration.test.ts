import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '../src/config/configuration.js';

describe('configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid PORT=%s', (port) => {
    vi.stubEnv('PORT', port);

    expect(() => configuration()).toThrow('PORT must be a positive integer');
  });
});

it('requires explicit production tables and SDK Task Role credentials', () => {
  const original = process.env;
  const production = {
    NODE_ENV: 'production',
    AWS_REGION: 'ap-northeast-2',
    DYNAMODB_NOTIFICATIONS_TABLE: 'actual-notifications',
    DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE: 'actual-subscriptions',
    DYNAMODB_EVENT_STATE_TABLE: 'actual-events',
  };
  try {
    process.env = { ...production };
    expect(configuration().dynamodb.notificationsTable).toBe(
      'actual-notifications',
    );
    for (const name of [
      'DYNAMODB_ENDPOINT',
      'AWS_ENDPOINT_URL',
      'AWS_ENDPOINT_URL_DYNAMODB',
      'AWS_ACCESS_KEY_ID',
      'AWS_SECRET_ACCESS_KEY',
      'AWS_SESSION_TOKEN',
      'AWS_PROFILE',
    ]) {
      process.env = { ...production, [name]: 'local' };
      expect(() => configuration()).toThrow(name);
    }
    for (const name of [
      'AWS_REGION',
      'DYNAMODB_NOTIFICATIONS_TABLE',
      'DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE',
      'DYNAMODB_EVENT_STATE_TABLE',
    ]) {
      process.env = { ...production, [name]: '' };
      expect(() => configuration()).toThrow(name);
    }
    process.env = {
      NODE_ENV: 'development',
      DYNAMODB_ENDPOINT: 'http://localhost:8002',
    };
    expect(configuration().dynamodb.endpoint).toBe('http://localhost:8002');
  } finally {
    process.env = original;
  }
});
