export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  host: string;
  port: number;
  logLevel: string;
  logPretty: boolean;
  websocket: {
    path: string;
    allowedOrigins: string[];
    maxPayloadBytes: number;
    heartbeatIntervalMs: number;
    heartbeatTimeoutMs: number;
    maxRoomsPerSocket: number;
  };
  jwt: {
    secret: string;
    issuer: string;
    audience: string;
    cookieName: string;
    jwksUrl?: string;
  };
  postService: { url: string; serviceSecret: string; issuer: string; audience: string };
  redisUrl: string;
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

function csv(name: string, fallback: string): string[] {
  return (process.env[name] ?? fallback)
    .split(',')
    .map((value) => value.trim())
    .filter(Boolean);
}

export function loadConfig(): AppConfig {
  const nodeEnv = process.env.NODE_ENV ?? 'development';
  if (nodeEnv !== 'development' && nodeEnv !== 'test' && nodeEnv !== 'production') {
    throw new Error('NODE_ENV must be development, test, or production');
  }

  const jwtSecret = process.env.JWT_SECRET
    ?? (nodeEnv === 'production' ? '' : 'local-development-secret-change-me');
  if (nodeEnv === 'production' && (!process.env.JWT_JWKS_URL || !process.env.JWT_ISSUER || !process.env.JWT_AUDIENCE)) {
    throw new Error('JWT_JWKS_URL, JWT_ISSUER and JWT_AUDIENCE are required in production');
  }
  if (nodeEnv !== 'production' && jwtSecret.length < 32) {
    throw new Error('JWT_SECRET must contain at least 32 characters in development');
  }
  const serviceSecret = process.env.WS_SERVICE_JWT_SECRET ?? (nodeEnv === 'production' ? '' : 'local-ws-service-secret-change-me-at-least-32');
  if (serviceSecret.length < 32) throw new Error('WS_SERVICE_JWT_SECRET must contain at least 32 characters');

  const path = process.env.WS_PATH ?? '/ws/v1';
  if (!path.startsWith('/')) throw new Error('WS_PATH must start with /');

  const heartbeatIntervalMs = integer('WS_HEARTBEAT_INTERVAL_MS', 30_000, 1);
  const heartbeatTimeoutMs = integer('WS_HEARTBEAT_TIMEOUT_MS', 10_000, 1);
  if (heartbeatTimeoutMs >= heartbeatIntervalMs) {
    throw new Error('WS_HEARTBEAT_TIMEOUT_MS must be less than WS_HEARTBEAT_INTERVAL_MS');
  }

  return {
    nodeEnv,
    host: process.env.HOST ?? '127.0.0.1',
    port: integer('PORT', 8081, 1),
    logLevel: process.env.LOG_LEVEL ?? 'debug',
    logPretty: boolean('LOG_PRETTY', true),
    websocket: {
      path,
      allowedOrigins: csv(
        'WS_ALLOWED_ORIGINS',
        'http://localhost:3000,http://localhost:5173',
      ),
      maxPayloadBytes: integer('WS_MAX_PAYLOAD_BYTES', 65_536, 1),
      heartbeatIntervalMs,
      heartbeatTimeoutMs,
      maxRoomsPerSocket: integer('WS_MAX_ROOMS_PER_SOCKET', 50, 1),
    },
    jwt: {
      secret: jwtSecret,
      issuer: process.env.JWT_ISSUER ?? 'wgo-user-service',
      audience: process.env.JWT_AUDIENCE ?? 'wgo-realtime-gateway',
      cookieName: process.env.JWT_COOKIE_NAME ?? 'wgo_access_token',
      ...(process.env.JWT_JWKS_URL ? { jwksUrl: process.env.JWT_JWKS_URL } : {}),
    },
    postService: {
      url: process.env.POST_SERVICE_URL ?? 'http://127.0.0.1:3002',
      serviceSecret,
      issuer: process.env.WS_SERVICE_JWT_ISSUER ?? 'wgo-ws-gateway',
      audience: process.env.WS_SERVICE_JWT_AUDIENCE ?? 'wgo-post-service',
    },
    redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:6380',
  };
}
