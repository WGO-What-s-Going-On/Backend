import { afterEach, describe, expect, it, vi } from 'vitest';

import { configuration } from '../src/config/configuration.js';

describe('configuration', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('rejects incomplete explicit Firebase credentials and permits Workload Identity', () => {
    vi.stubEnv('FIREBASE_PROJECT_ID', 'demo-project');
    vi.stubEnv('FIREBASE_CLIENT_EMAIL', '');
    vi.stubEnv('FIREBASE_PRIVATE_KEY', '');
    expect(configuration().firebase.projectId).toBe('demo-project');
    vi.stubEnv(
      'FIREBASE_CLIENT_EMAIL',
      'sender@demo-project.iam.gserviceaccount.com',
    );
    expect(() => configuration()).toThrow('both FIREBASE_CLIENT_EMAIL');
  });

  it.each(['0', '-1', '1.5', 'invalid'])('rejects invalid PORT=%s', (port) => {
    vi.stubEnv('PORT', port);

    expect(() => configuration()).toThrow('PORT must be a positive integer');
  });
});

it('requires production Cloud SQL identity and keeps runtime settings separate', () => {
  const original = process.env;
  try {
    process.env = {
      NODE_ENV: 'production',
      DB_CONNECTION_MODE: 'cloud-sql-proxy',
      DB_HOST: '127.0.0.1',
      DB_NAME: 'wgo_notification',
      DB_USER: 'notification@project.iam',
    };
    expect(configuration().database.database).toBe('wgo_notification');
    delete process.env.DB_USER;
    expect(() => configuration()).toThrow('DB_USER');
  } finally {
    process.env = original;
  }
});
