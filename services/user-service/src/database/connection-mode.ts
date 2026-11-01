export function databaseConnectionMode(env = process.env) {
  const mode = env.DB_CONNECTION_MODE ?? 'direct';
  if (mode !== 'direct' && mode !== 'cloud-sql-proxy')
    throw new Error('DB_CONNECTION_MODE must be direct or cloud-sql-proxy');
  if (env.DB_AUTH_MODE)
    throw new Error(
      'DB_AUTH_MODE is no longer supported; use DB_CONNECTION_MODE',
    );
  if (mode === 'cloud-sql-proxy') {
    // Only a sidecar in the same Pod may terminate the unencrypted local connection.
    if (!['127.0.0.1', '::1'].includes(env.DB_HOST ?? ''))
      throw new Error('Cloud SQL proxy requires a literal loopback DB_HOST');
    if (!env.DB_USER?.trim() || !env.DB_NAME?.trim())
      throw new Error('Cloud SQL proxy requires explicit DB_USER and DB_NAME');
    if (env.DB_PASSWORD)
      throw new Error(
        'DB_PASSWORD must be omitted with automatic IAM proxy authentication',
      );
    if (env.DB_TLS_MODE && env.DB_TLS_MODE !== 'disable')
      throw new Error(
        'Cloud SQL proxy requires DB_TLS_MODE=disable on the local connection',
      );
    if (env.DB_TLS_CA_PATH || env.DB_TLS_CA_SOURCE)
      throw new Error(
        'Cloud SQL proxy manages upstream TLS; omit DB_TLS_CA settings',
      );
  }
  return mode;
}
