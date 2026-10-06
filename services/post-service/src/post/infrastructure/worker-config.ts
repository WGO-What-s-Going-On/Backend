function integer(name: string, fallback: number): number {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}

export function eventWorkerConfig() {
  const config = {
    pollMs: integer('OUTBOX_POLL_INTERVAL_MS', 1000),
    batchSize: integer('OUTBOX_BATCH_SIZE', 100),
    maxAttempts: integer('OUTBOX_MAX_ATTEMPTS', 10),
    redisTimeoutMs: integer('OUTBOX_REDIS_TIMEOUT_MS', 2000),
    leaseMs: integer('OUTBOX_LEASE_MS', 30000),
    expirationPollMs: integer('POST_EXPIRATION_POLL_INTERVAL_MS', 1000),
  };
  if (config.leaseMs <= config.redisTimeoutMs * 2)
    throw new Error(
      'OUTBOX_LEASE_MS must exceed twice OUTBOX_REDIS_TIMEOUT_MS',
    );
  return config;
}
