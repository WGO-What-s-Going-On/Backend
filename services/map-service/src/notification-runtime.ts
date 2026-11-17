import { createClient } from 'redis';
import type { Server } from '@grpc/grpc-js';
import type { LocationStore } from './location.js';
import { registerNotificationGrpc } from './notification-grpc.js';
import { NotificationRecipientIndex } from './notification-recipient-index.js';
import { LocationGeoIndex } from './location-geo-index.js';
import { createLogger } from './observability/logging.js';

// New notification configuration and connections must never prevent existing Map startup.
export function registerNotificationRecipients(
  server: Server,
  store: LocationStore,
): () => Promise<void> {
  if (process.env.MAP_NEARBY_NOTIFICATIONS_ENABLED !== 'true')
    return async () => {};
  const log = createLogger('map-service', 'notification-recipients');
  const redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6381',
    disableOfflineQueue: true,
    commandsQueueMaxLength: 1000,
  });
  const index = new NotificationRecipientIndex(redis, store);
  const locations = new LocationGeoIndex(redis, store);
  try {
    registerNotificationGrpc(server, index, locations);
  } catch (error) {
    log.failure(
      'notification_index.configuration_failed',
      error,
      'RECIPIENT_INDEX_UNAVAILABLE',
      'Notification recipient RPC unavailable; existing Map remains enabled.',
    );
    return async () => {};
  }
  let stopping = false;
  redis.on('error', (error) =>
    log.failure(
      'notification_index.redis_failed',
      error,
      'RECIPIENT_INDEX_UNAVAILABLE',
      'Notification recipient index unavailable.',
    ),
  );
  void redis
    .connect()
    .then(() => {
      if (!stopping) {
        index.start();
        locations.start();
      }
    })
    .catch((error) =>
      log.failure(
        'notification_index.start_failed',
        error,
        'RECIPIENT_INDEX_UNAVAILABLE',
        'Notification recipient index unavailable.',
      ),
    );
  return async () => {
    stopping = true;
    await locations.close();
    await index.close();
    if (redis.isReady) await redis.quit().catch(() => redis.destroy());
    else if (redis.isOpen) redis.destroy();
  };
}
