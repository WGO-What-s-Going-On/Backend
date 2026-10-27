import { Signer } from '@aws-sdk/rds-signer';

export type DatabasePassword = string | (() => Promise<string>);

export function databasePassword(
  connection: { host: string; port: number; username: string },
  env = process.env,
): DatabasePassword {
  const mode = env.DB_AUTH_MODE ?? 'password';
  if (mode === 'password') return env.DB_PASSWORD ?? 'wgo';
  if (mode !== 'iam') throw new Error('DB_AUTH_MODE must be password or iam');
  if (!env.AWS_REGION?.trim())
    throw new Error('AWS_REGION is required for DB IAM authentication');
  if (!env.DB_HOST?.trim() || !env.DB_USER?.trim())
    throw new Error(
      'DB_HOST and DB_USER are required for DB IAM authentication',
    );
  if (env.DB_PASSWORD)
    throw new Error('DB_PASSWORD must be omitted for DB IAM authentication');
  if (env.DB_TLS_MODE !== 'verify-full')
    throw new Error(
      'DB_TLS_MODE=verify-full is required for DB IAM authentication',
    );

  const signer = new Signer({
    region: env.AWS_REGION,
    hostname: connection.host,
    port: connection.port,
    username: connection.username,
  });
  // pg calls this for every new connection; storing one token would fail after its 15-minute lifetime.
  // The SDK resolves and refreshes ECS task credentials without static AWS keys in the application.
  return () => signer.getAuthToken();
}
