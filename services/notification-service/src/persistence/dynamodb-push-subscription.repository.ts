import {
  GetCommand,
  QueryCommand,
  ScanCommand,
  TransactWriteCommand,
  type DynamoDBDocumentClient,
} from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import { DYNAMODB_DOCUMENT_CLIENT } from './dynamodb.client.js';
import type { PushSubscriptionRepository } from '../push-subscription/push-subscription.repository.js';
import type { PushSubscription } from '../push-subscription/push-subscription.js';
const OWNER = '__TOKEN_OWNER__';
const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
@Injectable()
export class DynamoDbPushSubscriptionRepository
  implements PushSubscriptionRepository
{
  private readonly table: string;
  constructor(
    @Inject(DYNAMODB_DOCUMENT_CLIENT)
    private readonly client: DynamoDBDocumentClient,
    config: ConfigService,
  ) {
    this.table =
      config.get<string>('dynamodb.pushSubscriptionsTable') ??
      'push-subscriptions';
  }
  async upsert(subscription: PushSubscription): Promise<PushSubscription> {
    if (subscription.userId === OWNER)
      throw new Error('Invalid subscription owner');
    const owner = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { userId: OWNER, token: digest(subscription.token) },
        ConsistentRead: true,
      }),
    );
    if (!owner.Item) {
      // 기존 token 행에는 소유권 행이 없으므로 최초 갱신 전에 다른 사용자 기록을 대조한다.
      let cursor: Record<string, unknown> | undefined;
      do {
        const legacy = await this.client.send(
          new ScanCommand({
            TableName: this.table,
            FilterExpression:
              '#token = :token AND userId <> :user AND userId <> :owner',
            ExpressionAttributeNames: { '#token': 'token' },
            ExpressionAttributeValues: {
              ':token': subscription.token,
              ':user': subscription.userId,
              ':owner': OWNER,
            },
            ConsistentRead: true,
            ...(cursor ? { ExclusiveStartKey: cursor } : {}),
          }),
        );
        if (legacy.Items?.length)
          throw new Error('Token already belongs to another user');
        cursor = legacy.LastEvaluatedKey;
      } while (cursor);
    }
    // token 소유권과 사용자 행을 함께 저장하여 다른 사용자의 token 탈취를 막는다.
    await this.client.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Put: {
              TableName: this.table,
              Item: {
                userId: OWNER,
                token: digest(subscription.token),
                ownerUserId: subscription.userId,
              },
              ConditionExpression:
                'attribute_not_exists(ownerUserId) OR ownerUserId = :user',
              ExpressionAttributeValues: { ':user': subscription.userId },
            },
          },
          {
            Update: {
              TableName: this.table,
              Key: { userId: subscription.userId, token: subscription.token },
              UpdateExpression:
                'SET platform = :platform, createdAt = if_not_exists(createdAt, :created), updatedAt = :updated, lastSeenAt = :seen',
              ExpressionAttributeValues: {
                ':platform': subscription.platform,
                ':created': subscription.createdAt,
                ':updated': subscription.updatedAt,
                ':seen': subscription.lastSeenAt,
              },
            },
          },
        ],
      }),
    );
    const result = await this.client.send(
      new GetCommand({
        TableName: this.table,
        Key: { userId: subscription.userId, token: subscription.token },
        ConsistentRead: true,
      }),
    );
    return result.Item as PushSubscription;
  }
  async remove(userId: string, token: string): Promise<void> {
    if (userId === OWNER) throw new Error('Invalid subscription owner');
    try {
      await this.client.send(
        new TransactWriteCommand({
          TransactItems: [
            { Delete: { TableName: this.table, Key: { userId, token } } },
            {
              Delete: {
                TableName: this.table,
                Key: { userId: OWNER, token: digest(token) },
                ConditionExpression:
                  'attribute_not_exists(ownerUserId) OR ownerUserId = :user',
                ExpressionAttributeValues: { ':user': userId },
              },
            },
          ],
        }),
      );
    } catch (error) {
      const reasons = (error as { CancellationReasons?: { Code?: string }[] })
        .CancellationReasons;
      if (reasons?.[1]?.Code === 'ConditionalCheckFailed') return;
      throw error;
    }
  }
  async list(userId: string): Promise<PushSubscription[]> {
    if (userId === OWNER) throw new Error('Invalid subscription owner');
    const items: PushSubscription[] = [];
    let cursor: Record<string, unknown> | undefined;
    do {
      const result = await this.client.send(
        new QueryCommand({
          TableName: this.table,
          KeyConditionExpression: 'userId = :userId',
          ExpressionAttributeValues: { ':userId': userId },
          ConsistentRead: true,
          ...(cursor ? { ExclusiveStartKey: cursor } : {}),
        }),
      );
      items.push(...((result.Items ?? []) as PushSubscription[]));
      cursor = result.LastEvaluatedKey;
    } while (cursor);
    return items;
  }
  async removeTokens(userId: string, tokens: string[]): Promise<void> {
    for (const token of new Set(tokens)) await this.remove(userId, token);
  }
}
