import {
  CreateTableCommand,
  DescribeTableCommand,
  DynamoDBClient,
  UpdateTimeToLiveCommand,
  waitUntilTableExists,
} from '@aws-sdk/client-dynamodb';

const endpoint = process.env.DYNAMODB_ENDPOINT ?? 'http://127.0.0.1:8002';
if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(endpoint).hostname))
  throw new Error('db:local only accepts a loopback DynamoDB Local endpoint');
const client = new DynamoDBClient({
  endpoint,
  region: 'local',
  credentials: { accessKeyId: 'local', secretAccessKey: 'local' },
});
const notifications =
  process.env.DYNAMODB_NOTIFICATIONS_TABLE ?? 'notifications';
const tables = [
  [notifications, 'userId', 'notificationId'],
  [
    process.env.DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE ?? 'push-subscriptions',
    'userId',
    'token',
  ],
  [
    process.env.DYNAMODB_EVENT_STATE_TABLE ?? 'notification-event-state',
    'postId',
    'key',
  ],
];
try {
  for (const [TableName, pk, sk] of tables) {
    try {
      await client.send(new DescribeTableCommand({ TableName }));
    } catch (error) {
      if (error.name !== 'ResourceNotFoundException') throw error;
      await client.send(
        new CreateTableCommand({
          TableName,
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
      await waitUntilTableExists(
        { client, maxWaitTime: 30, minDelay: 1, maxDelay: 1 },
        { TableName },
      );
    }
    console.info(`Local table ready: ${TableName}`);
  }
  await client.send(
    new UpdateTimeToLiveCommand({
      TableName: notifications,
      TimeToLiveSpecification: { AttributeName: 'expiresAt', Enabled: true },
    }),
  );
} finally {
  client.destroy();
}
