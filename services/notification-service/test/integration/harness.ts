import { ConfigService } from '@nestjs/config';
import {
  CreateTableCommand,
  DeleteTableCommand,
  DynamoDBClient,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { DynamoDbNotificationRepository } from '../../src/persistence/dynamodb-notification.repository.js';
import { DynamoDbPushSubscriptionRepository } from '../../src/persistence/dynamodb-push-subscription.repository.js';
import { NotificationService } from '../../src/notification/notification.service.js';
import { NotificationState } from '../../src/redis/notification-state.js';
import { PushSubscriptionService } from '../../src/push-subscription/push-subscription.service.js';

export async function harness() {
  const endpoint =
    process.env.NOTIFICATION_TEST_DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8002';
  if (!['127.0.0.1', 'localhost', '[::1]'].includes(new URL(endpoint).hostname))
    throw new Error(
      'Integration tests require a loopback DynamoDB Local endpoint',
    );
  const redisUrl =
    process.env.NOTIFICATION_TEST_REDIS_URL ?? 'redis://localhost:6382/15';
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
  const id = `notification_test_${randomUUID().replaceAll('-', '')}`;
  const tables = {
    notificationsTable: id + '_notifications',
    pushSubscriptionsTable: id + '_tokens',
    eventStateTable: id + '_state',
  };
  const config = new ConfigService({
    redis: { url: redisUrl, pendingIdleMs: 0, blockMs: 1 },
    dynamodb: { endpoint, region: 'local', ...tables },
  });
  const low = new DynamoDBClient({
    endpoint,
    region: 'local',
    credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
  });
  const client = DynamoDBDocumentClient.from(low, {
    marshallOptions: { removeUndefinedValues: true },
  });
  const created: string[] = [];
  try {
    for (const [name, table] of Object.entries(tables)) {
      const pk = name === 'eventStateTable' ? 'postId' : 'userId';
      const sk =
        name === 'eventStateTable'
          ? 'key'
          : name === 'notificationsTable'
            ? 'notificationId'
            : 'token';
      await low.send(
        new CreateTableCommand({
          TableName: table,
          BillingMode: 'PAY_PER_REQUEST',
          AttributeDefinitions: [
            { AttributeName: pk, AttributeType: 'S' },
            { AttributeName: sk, AttributeType: 'S' },
          ],
          KeySchema: [
            { AttributeName: pk, KeyType: 'HASH' },
            { AttributeName: sk, KeyType: 'RANGE' },
          ],
        }),
      );
      created.push(table);
      await waitUntilTableExists(
        { client: low, maxWaitTime: 20, minDelay: 1, maxDelay: 1 },
        { TableName: table },
      );
    }
  } catch (error) {
    for (const TableName of created)
      await low.send(new DeleteTableCommand({ TableName }));
    await redis.quit();
    low.destroy();
    throw error;
  }
  const repository = new DynamoDbNotificationRepository(client, config);
  const stateClient = createClient({
    url: redisUrl,
    socket: { reconnectStrategy: false, connectTimeout: 1000 },
  });
  stateClient.on('error', () => undefined);
  const state = new NotificationState(stateClient as never);
  const notifications = new NotificationService(repository, state);
  const subscriptionRepository = new DynamoDbPushSubscriptionRepository(
    client,
    config,
  );
  const subscriptions = new PushSubscriptionService(subscriptionRepository);
  const ownedKeys = new Set<string>();
  async function cleanup() {
    await state.onModuleDestroy();
    if (ownedKeys.size) await redis.del([...ownedKeys]);
    await redis.quit();
    for (const TableName of created)
      await low.send(new DeleteTableCommand({ TableName }));
    low.destroy();
  }
  return {
    config,
    client,
    low,
    tables,
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
