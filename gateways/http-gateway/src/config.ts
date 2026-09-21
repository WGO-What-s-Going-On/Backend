export type ServiceName =
  | 'user'
  | 'post'
  | 'map'
  | 'notification'
  | 'moderation';

export interface AppConfig {
  nodeEnv: 'development' | 'test';
  host: string;
  port: number;
  logLevel: string;
  logPretty: boolean;
  bodyLimitBytes: number;
  corsOrigins: string[];
  rateLimit: {
    enabled: boolean;
    max: number;
    windowMs: number;
    redisUrl: string;
  };
  upstream: {
    requestTimeoutMs: number;
    maxRetries: number;
  };
  services: Record<ServiceName, string>;
}

function integer(name: string, fallback: number, minimum = 0): number {
  const raw = process.env[name];
  const value = raw === undefined ? fallback : Number(raw);

  if (!Number.isSafeInteger(value) || value < minimum) {
    throw new Error(`${name} must be an integer greater than or equal to ${minimum}`);
  }

  return value;
}

function boolean(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new Error(`${name} must be either true or false`);
}

function url(name: string, fallback: string): string {
  const value = process.env[name] ?? fallback;

  try {
    const parsed = new URL(value);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:' && parsed.protocol !== 'redis:') {
      throw new Error('unsupported protocol');
    }
  } catch {
    throw new Error(`${name} must be a valid HTTP(S) or Redis URL`);
  }

  return value.replace(/\/$/, '');
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test') {
    throw new Error('NODE_ENV must be development or test for the local gateway setup');
  }

  return {
    nodeEnv,
    host: process.env.HOST ?? '127.0.0.1',
    port: integer('PORT', 8080, 1),
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    logPretty: boolean('LOG_PRETTY', true),
    bodyLimitBytes: integer('BODY_LIMIT_BYTES', 1_048_576, 1),
    corsOrigins: (process.env.CORS_ORIGINS ?? 'http://localhost:3000,http://localhost:5173')
      .split(',')
      .map((origin) => origin.trim())
      .filter(Boolean),
    rateLimit: {
      enabled: boolean('RATE_LIMIT_ENABLED', true),
      max: integer('RATE_LIMIT_MAX', 100, 1),
      windowMs: integer('RATE_LIMIT_WINDOW_MS', 60_000, 1),
      redisUrl: url('REDIS_URL', 'redis://127.0.0.1:6379'),
    },
    upstream: {
      requestTimeoutMs: integer('UPSTREAM_REQUEST_TIMEOUT_MS', 5_000, 1),
      maxRetries: integer('UPSTREAM_MAX_RETRIES', 1, 0),
    },
    services: {
      user: url('USER_SERVICE_URL', 'http://127.0.0.1:3001'),
      post: url('POST_SERVICE_URL', 'http://127.0.0.1:3002'),
      map: url('MAP_SERVICE_URL', 'http://127.0.0.1:3003'),
      notification: url('NOTIFICATION_SERVICE_URL', 'http://127.0.0.1:3004'),
      moderation: url('MODERATION_SERVICE_URL', 'http://127.0.0.1:3005'),
    },
  };
}
