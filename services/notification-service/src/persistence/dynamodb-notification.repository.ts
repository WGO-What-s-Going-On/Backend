import { BadRequestException, Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';

import type {
  Notification,
  NotificationPage,
} from '../notification/notification.js';
import type { NotificationRepository } from '../notification/notification.repository.js';
import { DYNAMODB_DOCUMENT_CLIENT } from './dynamodb.client.js';

@Injectable()
export class DynamoDbNotificationRepository implements NotificationRepository {
  private readonly table: string;

  constructor(
    @Inject(DYNAMODB_DOCUMENT_CLIENT)
    private readonly client: DynamoDBDocumentClient,
    config: ConfigService,
  ) {
    this.table =
      config.get<string>('dynamodb.notificationsTable') ?? 'notifications';
  }

  async create(notification: Notification): Promise<boolean> {
    try {
      await this.client.send(
        new PutCommand({
          TableName: this.table,
          Item: notification,
          ConditionExpression: 'attribute_not_exists(notificationId)',
        }),
      );
      return true;
    } catch (error) {
      if (
        (error as { name?: string }).name === 'ConditionalCheckFailedException'
      )
        return false;
      throw error;
    }
  }

  async list(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<NotificationPage> {
    const items: Notification[] = [];
    let lastKey = cursor ? decodeCursor(cursor, userId) : undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: {
            ':userId': userId,
            ':zero': 0,
            ':now': Math.floor(Date.now() / 1000),
          },
          ExpressionAttributeNames: { '#count': 'count' },
          FilterExpression: '#count > :zero AND expiresAt > :now',
          ConsistentRead: true,
          ScanIndexForward: false,
          Limit: limit - items.length,
          ...(lastKey ? { ExclusiveStartKey: lastKey } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as Notification[]));
      lastKey = result.LastEvaluatedKey as Record<string, string> | undefined;
    } while (lastKey && items.length < limit);
    return {
      items,
      ...(lastKey
        ? { nextCursor: encodeCursor(lastKey.notificationId as string) }
        : {}),
    };
  }

  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<Notification | null> {
    try {
      const result = await this.client.send(
        new UpdateCommand({
          TableName: this.table,
          Key: { userId, notificationId },
          UpdateExpression: 'SET isRead = :true',
          ConditionExpression:
            'attribute_exists(notificationId) AND isRead = :false',
          ExpressionAttributeValues: { ':true': true, ':false': false },
          ReturnValues: 'ALL_NEW',
        }),
      );
      return (result.Attributes as Notification | undefined) ?? null;
    } catch (error) {
      if (
        (error as { name?: string }).name === 'ConditionalCheckFailedException'
      ) {
        const existing = await this.client.send(
          new GetCommand({
            TableName: this.table,
            Key: { userId, notificationId },
            ConsistentRead: true,
          }),
        );
        return (existing.Item as Notification | undefined) ?? null;
      }
      throw error;
    }
  }

  async increment(
    userId: string,
    notificationId: string,
  ): Promise<Notification | null> {
    const result = await this.client.send(
      new UpdateCommand({
        TableName: this.table,
        Key: { userId, notificationId },
        UpdateExpression: 'ADD #count :one',
        ConditionExpression: 'attribute_exists(notificationId)',
        ExpressionAttributeNames: { '#count': 'count' },
        ExpressionAttributeValues: { ':one': 1 },
        ReturnValues: 'ALL_NEW',
      }),
    );
    return (result.Attributes as Notification | undefined) ?? null;
  }

  async countUnread(userId: string): Promise<number> {
    let cursor: Record<string, unknown> | undefined;
    let count = 0;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'userId = :userId',
          FilterExpression:
            'isRead = :false AND #count > :zero AND expiresAt > :now',
          ExpressionAttributeNames: { '#count': 'count' },
          ExpressionAttributeValues: {
            ':userId': userId,
            ':false': false,
            ':zero': 0,
            ':now': Math.floor(Date.now() / 1000),
          },
          ConsistentRead: true,
          Select: 'COUNT',
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
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
  if (
    !notificationId ||
    !/^[A-Za-z0-9_-]+$/.test(cursor) ||
    encodeCursor(notificationId) !== cursor
  )
    throw new BadRequestException('invalid cursor');
  return { userId, notificationId };
}
