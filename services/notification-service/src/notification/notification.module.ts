import { Module } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { createDynamoDocumentClient, DYNAMODB_DOCUMENT_CLIENT } from '../persistence/dynamodb.client.js';
import { DynamoDbNotificationRepository } from '../persistence/dynamodb-notification.repository.js';
import { NOTIFICATION_REPOSITORY } from './notification.repository.js';
import { NotificationService } from './notification.service.js';

@Module({
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
    NotificationService,
  ],
  exports: [NotificationService, NOTIFICATION_REPOSITORY],
})
export class NotificationModule {}
