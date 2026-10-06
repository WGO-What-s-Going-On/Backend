import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createDynamoDocumentClient, DYNAMODB_DOCUMENT_CLIENT } from '../persistence/dynamodb.client.js';
import { DynamoDbNotificationRepository } from '../persistence/dynamodb-notification.repository.js';
import { DynamoDbPushSubscriptionRepository } from '../persistence/dynamodb-push-subscription.repository.js';
import { PUSH_SUBSCRIPTION_REPOSITORY } from '../push-subscription/push-subscription.repository.js';
import { PushSubscriptionService } from '../push-subscription/push-subscription.service.js';
import { NotificationController } from './notification.controller.js';
import { FirebasePushAdapter } from '../firebase/firebase-push.adapter.js';
import { PUSH_SENDER } from '../firebase/push.js';
import { NotificationState } from '../redis/notification-state.js';
import { NOTIFICATION_REPOSITORY } from './notification.repository.js';
import { NotificationService } from './notification.service.js';

@Module({
  controllers: [NotificationController],
  providers: [
    {
      provide: DYNAMODB_DOCUMENT_CLIENT,
      inject: [ConfigService],
      useFactory: createDynamoDocumentClient,
    },
    {
      provide: NOTIFICATION_REPOSITORY,
      useClass: DynamoDbNotificationRepository,
    },
    {
      provide: PUSH_SUBSCRIPTION_REPOSITORY,
      useClass: DynamoDbPushSubscriptionRepository,
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
  ],
  exports: [NotificationService, NOTIFICATION_REPOSITORY],
})
export class NotificationModule {}
