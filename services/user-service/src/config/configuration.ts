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
  };
}
