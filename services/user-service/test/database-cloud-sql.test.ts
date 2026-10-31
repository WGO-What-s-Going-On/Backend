import { afterEach, describe, expect, it, vi } from 'vitest';
import { ConfigService } from '@nestjs/config';
import { configuration } from '../src/config/configuration.js';
import { databasePassword } from '../src/database/auth.js';
import { createTypeOrmOptions } from '../src/database/typeorm.config.js';
import { databaseTls } from '../src/database/tls.js';

const env = {
  NODE_ENV: 'production',
  DB_CONNECTION_MODE: 'cloud-sql-proxy',
  DB_HOST: '127.0.0.1',
  DB_USER: 'user-app@project.iam',
  DB_NAME: 'wgo_user',
  DB_TLS_MODE: 'disable',
};
afterEach(() => vi.unstubAllEnvs());

describe('Cloud SQL proxy connections', () => {
  it('preserves local password authentication and requires explicit production credentials', () => {
    expect(databasePassword({})).toBe('wgo');
    expect(databasePassword({ DB_PASSWORD: 'local-password' })).toBe(
      'local-password',
    );
    expect(() => databasePassword({ NODE_ENV: 'production' })).toThrow(
      'DB_PASSWORD',
    );
  });

  it.each([
    [{ ...env, DB_CONNECTION_MODE: 'invalid' }, 'DB_CONNECTION_MODE'],
    [{ ...env, DB_AUTH_MODE: 'iam' }, 'DB_AUTH_MODE'],
    [{ ...env, DB_HOST: 'proxy.namespace.svc' }, 'loopback'],
    [{ ...env, DB_HOST: 'localhost' }, 'loopback'],
    [{ ...env, DB_USER: '' }, 'DB_USER'],
    [{ ...env, DB_NAME: '' }, 'DB_NAME'],
    [{ ...env, DB_PASSWORD: 'expired-token' }, 'DB_PASSWORD'],
    [{ ...env, DB_TLS_MODE: 'verify-full' }, 'DB_TLS_MODE'],
    [{ ...env, DB_TLS_CA_SOURCE: 'system' }, 'DB_TLS_CA'],
    [{ ...env, DB_TLS_CA_PATH: '/unused' }, 'DB_TLS_CA'],
  ])('rejects unsafe or conflicting proxy configuration %#', (input, field) => {
    expect(() => databasePassword(input)).toThrow(field);
    expect(() => databaseTls(input)).toThrow(field);
  });

  it('uses the same password-free loopback connection for the app and migration', async () => {
    for (const [name, value] of Object.entries(env)) vi.stubEnv(name, value);
    for (const name of [
      'DB_PASSWORD',
      'DB_AUTH_MODE',
      'DB_TLS_CA_PATH',
      'DB_TLS_CA_SOURCE',
    ])
      vi.stubEnv(name, undefined);
    const config = configuration();
    const options = createTypeOrmOptions(new ConfigService(config));
    expect(options).toMatchObject({
      host: '127.0.0.1',
      username: env.DB_USER,
      database: 'wgo_user',
      password: '',
      ssl: false,
      synchronize: false,
      poolSize: 10,
    });
    const migration = (await import('../src/database/data-source.js')).default;
    expect(migration.options).toMatchObject({
      host: '127.0.0.1',
      username: env.DB_USER,
      database: 'wgo_user',
      password: '',
      ssl: false,
      synchronize: false,
      poolSize: 10,
    });
  });

  it('keeps direct production TLS mandatory', () => {
    expect(() =>
      databaseTls({ NODE_ENV: 'production', DB_CONNECTION_MODE: 'direct' }),
    ).toThrow('verify-full');
    expect(
      databaseTls({
        NODE_ENV: 'production',
        DB_CONNECTION_MODE: 'direct',
        DB_TLS_MODE: 'verify-full',
        DB_TLS_CA_SOURCE: 'system',
      }),
    ).toEqual({ rejectUnauthorized: true });
  });
});
