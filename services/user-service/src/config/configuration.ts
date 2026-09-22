function positiveInteger(value: string | undefined, fallback: number, name: string): number {
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
