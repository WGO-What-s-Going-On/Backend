import { describe, expect, it } from 'vitest';
import { postgresConfig } from '../src/persistence/postgres.config.js';

describe('PostgreSQL connection boundary', () => {
  const production = {
    NODE_ENV: 'production',
    DB_HOST: '127.0.0.1',
    DB_USER: 'notification@project.iam',
    DB_NAME: 'wgo_notification',
  };
  it('allows only the local plaintext leg for automatic IAM proxy authentication', () => {
    expect(
      postgresConfig({ ...production, DB_CONNECTION_MODE: 'cloud-sql-proxy' }),
    ).toMatchObject({ ssl: false, user: production.DB_USER });
    expect(
      postgresConfig({ ...production, DB_CONNECTION_MODE: 'cloud-sql-proxy' }),
    ).not.toHaveProperty('password');
    expect(() =>
      postgresConfig({
        ...production,
        DB_CONNECTION_MODE: 'cloud-sql-proxy',
        DB_HOST: 'remote',
      }),
    ).toThrow('loopback');
    expect(() =>
      postgresConfig({
        ...production,
        DB_CONNECTION_MODE: 'cloud-sql-proxy',
        DB_PASSWORD: 'password',
      }),
    ).toThrow('no DB_PASSWORD');
  });
  it('requires server certificate validation for direct production connections', () => {
    expect(() => postgresConfig(production)).toThrow('verify-full');
    expect(
      postgresConfig({ ...production, DB_TLS_MODE: 'verify-full' }),
    ).toMatchObject({ ssl: { rejectUnauthorized: true } });
    expect(() => postgresConfig({ ...production, DB_USER: '' })).toThrow(
      'DB_USER',
    );
  });
  it('validates pool and port bounds', () => {
    expect(() => postgresConfig({ DB_PORT: '0' })).toThrow('DB_PORT');
    expect(() => postgresConfig({ DB_POOL_MAX: '101' })).toThrow('DB_POOL_MAX');
  });
});
