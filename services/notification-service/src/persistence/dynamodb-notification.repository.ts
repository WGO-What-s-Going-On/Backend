import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PutCommand, QueryCommand, UpdateCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import type { Notification, NotificationPage } from '../notification/notification.js';
import type { NotificationRepository } from '../notification/notification.repository.js';
import { DYNAMODB_DOCUMENT_CLIENT } from './dynamodb.client.js';

@Injectable()
export class DynamoDbNotificationRepository implements NotificationRepository {
  private readonly table: string;

  constructor(
    @Inject(DYNAMODB_DOCUMENT_CLIENT) private readonly client: DynamoDBDocumentClient,
    config: ConfigService,
  ) {
    this.table = config.get<string>('dynamodb.notificationsTable') ?? 'notifications';
  }

  async create(notification: Notification): Promise<void> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: notification, ConditionExpression: 'attribute_not_exists(notificationId)' }));
  }

  async list(userId: string, limit: number, cursor?: string): Promise<NotificationPage> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
      ScanIndexForward: false,
      Limit: limit,
      ...(cursor ? { ExclusiveStartKey: decodeCursor(cursor, userId) } : {}),
    }));
    return {
      items: (result.Items ?? []) as Notification[],
      ...(result.LastEvaluatedKey ? { nextCursor: encodeCursor(result.LastEvaluatedKey.notificationId as string) } : {}),
    };
  }

  async markRead(userId: string, notificationId: string): Promise<Notification | null> {
    try {
      const result = await this.client.send(new UpdateCommand({
        TableName: this.table,
        Key: { userId, notificationId },
        UpdateExpression: 'SET isRead = :true',
        ConditionExpression: 'attribute_exists(notificationId) AND isRead = :false',
        ExpressionAttributeValues: { ':true': true, ':false': false },
        ReturnValues: 'ALL_NEW',
      }));
      return (result.Attributes as Notification | undefined) ?? null;
    } catch (error) {
      if ((error as { name?: string }).name === 'ConditionalCheckFailedException') return null;
      throw error;
    }
  }

  async increment(userId: string, notificationId: string): Promise<Notification | null> {
    const result = await this.client.send(new UpdateCommand({
      TableName: this.table,
      Key: { userId, notificationId },
      UpdateExpression: 'ADD #count :one',
      ExpressionAttributeNames: { '#count': 'count' },
      ExpressionAttributeValues: { ':one': 1 },
      ReturnValues: 'ALL_NEW',
    }));
    return (result.Attributes as Notification | undefined) ?? null;
  }

  async countUnread(userId: string): Promise<number> {
    let cursor: Record<string, unknown> | undefined;
    let count = 0;
    do {
      const result = await this.client.send(new QueryCommand({
        TableName: this.table,
        KeyConditionExpression: 'userId = :userId',
        FilterExpression: 'isRead = :false',
        ExpressionAttributeValues: { ':userId': userId, ':false': false },
        Select: 'COUNT',
        ...(cursor ? { ExclusiveStartKey: cursor } : {}),
      }));
      count += result.Count ?? 0;
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return count;
  }
}

function encodeCursor(notificationId: string): string {
  return Buffer.from(notificationId, 'utf8').toString('base64url');
}

function decodeCursor(cursor: string, userId: string): Record<string, string> {
  const notificationId = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!notificationId) throw new Error('invalid cursor');
  return { userId, notificationId };
}
