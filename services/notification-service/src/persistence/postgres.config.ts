import { readFileSync } from 'node:fs';
import type { PoolConfig } from 'pg';

export function postgresConfig(
  env: NodeJS.ProcessEnv = process.env,
): PoolConfig {
  const mode = env.DB_CONNECTION_MODE ?? 'direct';
  const host = env.DB_HOST ?? '127.0.0.1';
  const port = Number(env.DB_PORT ?? 5432);
  const max = Number(env.DB_POOL_MAX ?? 10);
  if (!['direct', 'cloud-sql-proxy'].includes(mode))
    throw new Error('DB_CONNECTION_MODE must be direct or cloud-sql-proxy');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('DB_PORT must be a valid port');
  if (!Number.isInteger(max) || max < 1 || max > 100)
    throw new Error('DB_POOL_MAX must be between 1 and 100');
  if (env.NODE_ENV === 'production') {
    for (const name of ['DB_HOST', 'DB_USER', 'DB_NAME'])
      if (!env[name]?.trim())
        throw new Error(`${name} is required in production`);
  }
  const tls = env.DB_TLS_MODE ?? 'disable';
  if (!['disable', 'verify-full'].includes(tls))
    throw new Error('DB_TLS_MODE must be disable or verify-full');
  if (mode === 'cloud-sql-proxy') {
    // Only the local proxy leg is plaintext. The proxy authenticates and encrypts the Cloud SQL leg.
    if (!['127.0.0.1', '::1', 'localhost'].includes(host))
      throw new Error('Cloud SQL proxy must use a loopback DB_HOST');
    if (tls !== 'disable' || env.DB_PASSWORD)
      throw new Error(
        'Cloud SQL IAM proxy requires DB_TLS_MODE=disable and no DB_PASSWORD',
      );
  } else if (env.NODE_ENV === 'production' && tls !== 'verify-full') {
    throw new Error(
      'Direct production PostgreSQL requires DB_TLS_MODE=verify-full',
    );
  }
  if (
    env.NODE_ENV === 'production' &&
    mode === 'direct' &&
    !env.DB_PASSWORD?.trim()
  )
    throw new Error('DB_PASSWORD is required for direct production PostgreSQL');
  if (tls === 'disable' && env.DB_TLS_CA_PATH)
    throw new Error('DB_TLS_CA_PATH requires DB_TLS_MODE=verify-full');
  return {
    host,
    port,
    database: env.DB_NAME ?? 'wgo_notification',
    user: env.DB_USER ?? 'wgo',
    ...(mode === 'direct' ? { password: env.DB_PASSWORD ?? 'wgo' } : {}),
    ssl:
      tls === 'verify-full'
        ? {
            rejectUnauthorized: true,
            ...(env.DB_TLS_CA_PATH
              ? { ca: readFileSync(env.DB_TLS_CA_PATH, 'utf8') }
              : {}),
          }
        : false,
    max,
    connectionTimeoutMillis: 5000,
    idleTimeoutMillis: 10000,
    statement_timeout: 15000,
    lock_timeout: 5000,
  };
}
