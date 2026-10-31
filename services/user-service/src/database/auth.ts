import { databaseConnectionMode } from './connection-mode.js';

export function databasePassword(env = process.env): string {
  if (databaseConnectionMode(env) === 'cloud-sql-proxy') {
    // The proxy refreshes IAM tokens for every upstream connection, including migrations.
    return '';
  }
  if (env.NODE_ENV === 'production' && !env.DB_PASSWORD)
    throw new Error(
      'DB_PASSWORD is required for direct production connections',
    );
  return env.DB_PASSWORD ?? 'wgo';
}
