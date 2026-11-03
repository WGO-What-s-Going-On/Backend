import { ConfigService } from '@nestjs/config';
import { createClient } from 'redis';
import { PostgresNotificationRepository } from '../../src/persistence/postgres-notification.repository.js';
import { PostgresPushSubscriptionRepository } from '../../src/persistence/postgres-push-subscription.repository.js';
import { NotificationService } from '../../src/notification/notification.service.js';
import { NotificationState } from '../../src/redis/notification-state.js';
import { PushSubscriptionService } from '../../src/push-subscription/push-subscription.service.js';
import { postgresHarness } from './postgres-harness.js';

export async function harness() {
  const redisUrl =
    process.env.NOTIFICATION_TEST_REDIS_URL ?? 'redis://localhost:6382/15';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(redisUrl).hostname))
    throw new Error('Integration tests require a loopback Redis endpoint');
  const redis = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 2000 },
  });
  redis.on('error', () => undefined);
  await redis.connect();
  if ((await redis.dbSize()) !== 0) {
    await redis.quit();
    throw new Error('Test Redis DB must be empty; existing data preserved');
  }
  let pg: Awaited<ReturnType<typeof postgresHarness>>;
  try {
    pg = await postgresHarness();
  } catch (error) {
    await redis.quit();
    throw error;
  }
  const config = new ConfigService({
    redis: { url: redisUrl, pendingIdleMs: 0, blockMs: 1 },
  });
  const repository = new PostgresNotificationRepository(pg.database);
  const stateClient = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 1000 },
  });
  stateClient.on('error', () => undefined);
  const state = new NotificationState(stateClient as never);
  const notifications = new NotificationService(repository, state);
  const subscriptionRepository = new PostgresPushSubscriptionRepository(
    pg.database,
  );
  const subscriptions = new PushSubscriptionService(subscriptionRepository);
  const ownedKeys = new Set<string>();
  async function cleanup() {
    await state.onModuleDestroy();
    try {
      if (!redis.isOpen) await redis.connect();
      if (ownedKeys.size) await redis.del([...ownedKeys]);
    } finally {
      if (redis.isOpen) await redis.quit();
      await pg.cleanup();
    }
  }
  return {
    config,
    database: pg.database,
    schema: pg.schema,
    redis,
    state,
    stateClient,
    notifications,
    repository,
    subscriptions,
    subscriptionRepository,
    ownedKeys,
    cleanup,
  };
}
