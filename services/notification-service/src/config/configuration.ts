import { postgresConfig } from '../persistence/postgres.config.js';
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
  if (
    Boolean(process.env.FIREBASE_CLIENT_EMAIL?.trim()) !==
    Boolean(process.env.FIREBASE_PRIVATE_KEY?.trim())
  )
    throw new Error(
      'Firebase explicit credentials require both FIREBASE_CLIENT_EMAIL and FIREBASE_PRIVATE_KEY',
    );
  return {
    app: {
      port: positiveInteger(process.env.PORT, 3004, 'PORT'),
    },
    redis: {
      url: process.env.REDIS_URL,
    },
    database: postgresConfig(),
    firebase: {
      projectId: process.env.FIREBASE_PROJECT_ID,
      clientEmail: process.env.FIREBASE_CLIENT_EMAIL,
      privateKey: process.env.FIREBASE_PRIVATE_KEY,
    },
  };
}
