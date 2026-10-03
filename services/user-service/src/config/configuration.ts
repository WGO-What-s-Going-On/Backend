function positiveInteger(
  value: string | undefined,
  fallback: number,
  name: string,
): number {
  const parsed = Number(value ?? fallback);

  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }

  return parsed;
}

export function configuration() {
  return {
    app: {
      port: positiveInteger(process.env.PORT, 3001, 'PORT'),
    },
    database: {
      host: process.env.DB_HOST ?? 'localhost',
      port: positiveInteger(process.env.DB_PORT, 5432, 'DB_PORT'),
      username: process.env.DB_USER ?? 'wgo',
      password: process.env.DB_PASSWORD ?? 'wgo',
      name: process.env.DB_NAME ?? 'wgo_user',
    },
    redis: {
      url: process.env.REDIS_URL,
    },
    outbox: {
      pollIntervalMs: positiveInteger(
        process.env.OUTBOX_POLL_INTERVAL_MS,
        1000,
        'OUTBOX_POLL_INTERVAL_MS',
      ),
      batchSize: positiveInteger(
        process.env.OUTBOX_BATCH_SIZE,
        20,
        'OUTBOX_BATCH_SIZE',
      ),
      redisTimeoutMs: positiveInteger(
        process.env.OUTBOX_REDIS_TIMEOUT_MS,
        2000,
        'OUTBOX_REDIS_TIMEOUT_MS',
      ),
    },
    withdrawal: {
      pollIntervalMs: positiveInteger(
        process.env.WITHDRAWAL_POLL_INTERVAL_MS,
        60000,
        'WITHDRAWAL_POLL_INTERVAL_MS',
      ),
      batchSize: positiveInteger(
        process.env.WITHDRAWAL_BATCH_SIZE,
        20,
        'WITHDRAWAL_BATCH_SIZE',
      ),
    },
    grpc: {
      host: process.env.USER_GRPC_HOST ?? '127.0.0.1',
      port: positiveInteger(
        process.env.USER_GRPC_PORT,
        50052,
        'USER_GRPC_PORT',
      ),
      package: process.env.USER_GRPC_PACKAGE ?? 'wgo.user.v1',
      protoPath: process.env.USER_GRPC_PROTO_PATH ?? 'contracts/user.proto',
      trustedJwks: process.env.USER_SERVICE_TRUSTED_JWKS,
      serviceJwtSecret: process.env.USER_SERVICE_JWT_SECRET,
    },
    auth: {
      kakao: {
        restApiKey: process.env.KAKAO_REST_API_KEY,
        clientSecret: process.env.KAKAO_CLIENT_SECRET,
        redirectUri: process.env.KAKAO_REDIRECT_URI,
      },
      jwt: {
        accessSecret: process.env.JWT_ACCESS_SECRET,
        issuer: process.env.JWT_ACCESS_ISSUER,
        audience: process.env.JWT_ACCESS_AUDIENCE,
        accessTtlSeconds: process.env.JWT_ACCESS_TTL_SECONDS,
      },
      refreshTtlSeconds: process.env.JWT_REFRESH_TTL_SECONDS,
    },
  };
}
