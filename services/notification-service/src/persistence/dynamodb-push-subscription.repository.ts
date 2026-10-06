import { BatchWriteCommand, DeleteCommand, PutCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { Inject, Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

import { DYNAMODB_DOCUMENT_CLIENT } from './dynamodb.client.js';
import type { PushSubscriptionRepository } from '../push-subscription/push-subscription.repository.js';
import type { PushSubscription } from '../push-subscription/push-subscription.js';

@Injectable()
export class DynamoDbPushSubscriptionRepository implements PushSubscriptionRepository {
  private readonly table: string;

  constructor(
    @Inject(DYNAMODB_DOCUMENT_CLIENT) private readonly client: DynamoDBDocumentClient,
    config: ConfigService,
  ) {
    this.table = config.get<string>('dynamodb.pushSubscriptionsTable') ?? 'push-subscriptions';
  }

  async upsert(subscription: PushSubscription): Promise<PushSubscription> {
    await this.client.send(new PutCommand({ TableName: this.table, Item: subscription }));
    return subscription;
  }

  async remove(userId: string, token: string): Promise<void> {
    await this.client.send(new DeleteCommand({ TableName: this.table, Key: { userId, token } }));
  }

  async list(userId: string): Promise<PushSubscription[]> {
    const result = await this.client.send(new QueryCommand({
      TableName: this.table,
      KeyConditionExpression: 'userId = :userId',
      ExpressionAttributeValues: { ':userId': userId },
    }));
    return (result.Items ?? []) as PushSubscription[];
  }

  async removeTokens(userId: string, tokens: string[]): Promise<void> {
    if (tokens.length === 0) return;
    for (let offset = 0; offset < tokens.length; offset += 25) {
      await this.client.send(new BatchWriteCommand({
        RequestItems: {
          [this.table]: tokens.slice(offset, offset + 25).map((token) => ({
            DeleteRequest: { Key: { userId, token } },
          })),
        },
      }));
    }
  }
}
