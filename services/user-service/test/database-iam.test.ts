import { afterEach, describe, expect, it, vi } from 'vitest';
import { Signer } from '@aws-sdk/rds-signer';
import { ConfigService } from '@nestjs/config';
import { configuration } from '../src/config/configuration.js';
import { databasePassword } from '../src/database/auth.js';
import { createTypeOrmOptions } from '../src/database/typeorm.config.js';
import { databaseTls } from '../src/database/tls.js';

const connection = { host: 'db.example', port: 5432, username: 'wgo_user_app' };
const env = {
  DB_AUTH_MODE: 'iam',
  AWS_REGION: 'ap-northeast-2',
  DB_HOST: connection.host,
  DB_USER: connection.username,
  DB_TLS_MODE: 'verify-full',
  DB_TLS_CA_SOURCE: 'system',
};
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe('database IAM authentication', () => {
  it('preserves password authentication for existing configurations', () => {
    expect(databasePassword(connection, {})).toBe('wgo');
    expect(
      databasePassword(connection, { DB_PASSWORD: 'local-password' }),
    ).toBe('local-password');
  });

  it.each([
    [{ ...env, DB_AUTH_MODE: 'invalid' }, 'DB_AUTH_MODE'],
    [{ ...env, AWS_REGION: '' }, 'AWS_REGION'],
    [{ ...env, DB_HOST: '' }, 'DB_HOST'],
    [{ ...env, DB_USER: '' }, 'DB_USER'],
    [{ ...env, DB_PASSWORD: 'expired-token' }, 'DB_PASSWORD'],
    [{ ...env, DB_TLS_MODE: 'disable' }, 'DB_TLS_MODE'],
  ])('rejects unsafe or incomplete IAM configuration %#', (input, field) => {
    expect(() => databasePassword(connection, input)).toThrow(field);
  });

  it('passes a fresh-token callback to the application and migration configuration', async () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    vi.stubEnv('DB_PASSWORD', undefined);
    vi.stubEnv('DB_TLS_CA_PATH', undefined);
    vi.stubEnv('NODE_ENV', 'production');
    const getToken = vi
      .spyOn(Signer.prototype, 'getAuthToken')
      .mockResolvedValueOnce('first-token')
      .mockResolvedValueOnce('new-token')
      .mockRejectedValueOnce(new Error('credentials unavailable'));
    const config = configuration();
    const password = config.database.password;
    const options = createTypeOrmOptions(new ConfigService(config));
    if (options.type !== 'postgres') throw new Error('Expected PostgreSQL');
    expect(options.password).toBe(password);
    expect(typeof password).toBe('function');
    expect(getToken).not.toHaveBeenCalled();
    if (typeof password !== 'function')
      throw new Error('Expected IAM callback');
    await expect(password()).resolves.toBe('first-token');
    // A later/replacement connection must sign again, never reuse the initial token.
    await expect(password()).resolves.toBe('new-token');
    await expect(password()).rejects.toThrow('credentials unavailable');
    expect(options.ssl).toEqual({ rejectUnauthorized: true });
    const migration = (await import('../src/database/data-source.js')).default;
    if (migration.options.type !== 'postgres')
      throw new Error('Expected PostgreSQL migration');
    expect(typeof migration.options.password).toBe('function');
    expect(migration.options.ssl).toEqual({ rejectUnauthorized: true });
  });

  it('uses public roots with hostname verification and rejects conflicting CA settings', () => {
    expect(databaseTls(env)).toEqual({ rejectUnauthorized: true });
    expect(() =>
      databaseTls({ ...env, DB_TLS_CA_PATH: '/incorrect.pem' }),
    ).toThrow('must be omitted');
    expect(() => databaseTls({ ...env, DB_TLS_CA_SOURCE: 'insecure' })).toThrow(
      'DB_TLS_CA_SOURCE',
    );
    expect(() => databaseTls({ DB_TLS_CA_SOURCE: 'system' })).toThrow(
      'verify-full',
    );
  });
});
