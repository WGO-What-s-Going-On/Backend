import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { PostgresDatabase } from '../persistence/postgres.database.js';
import { PostgresNotificationRepository } from '../persistence/postgres-notification.repository.js';
import { PostgresPushSubscriptionRepository } from '../persistence/postgres-push-subscription.repository.js';
import { PUSH_SUBSCRIPTION_REPOSITORY } from '../push-subscription/push-subscription.repository.js';
import { PushSubscriptionService } from '../push-subscription/push-subscription.service.js';
import { NotificationReadinessController } from './readiness.controller.js';
import { NotificationController } from './notification.controller.js';
import { FirebasePushAdapter } from '../firebase/firebase-push.adapter.js';
import { PUSH_SENDER } from '../firebase/push.js';
import { NotificationState } from '../redis/notification-state.js';
import { PostEventConsumer } from '../event-consumer/post-event.consumer.js';
import { PostEventHandler } from '../event-consumer/post-event.handler.js';
import { PostgresEventStore } from '../persistence/postgres-event.store.js';
import { NOTIFICATION_REPOSITORY } from './notification.repository.js';
import { NotificationService } from './notification.service.js';
import { NotificationBlockChecker } from './block-checker.js';

@Module({
  controllers: [NotificationController, NotificationReadinessController],
  providers: [
    PostgresDatabase,
    {
      provide: NOTIFICATION_REPOSITORY,
      useClass: PostgresNotificationRepository,
    },
    {
      provide: PUSH_SUBSCRIPTION_REPOSITORY,
      useClass: PostgresPushSubscriptionRepository,
    },
    NotificationService,
    PushSubscriptionService,
    FirebasePushAdapter,
    { provide: PUSH_SENDER, useExisting: FirebasePushAdapter },
    {
      provide: NotificationState,
      inject: [ConfigService],
      useFactory: (config: ConfigService) =>
        NotificationState.fromUrl(
          config.get<string>('redis.url') ?? 'redis://localhost:6382',
        ),
    },
    PostgresEventStore,
    NotificationBlockChecker,
    PostEventHandler,
    PostEventConsumer,
  ],
  exports: [NotificationService, NOTIFICATION_REPOSITORY],
})
export class NotificationModule {}
