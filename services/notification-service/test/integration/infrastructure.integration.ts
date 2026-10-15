import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { expect, it } from 'vitest';
import { harness } from './harness.js';
import { spawnSync } from 'node:child_process';
it('connects only to dedicated local Redis/DynamoDB and creates isolated tables', async () => {
  const h = await harness();
  try {
    expect(await h.redis.ping()).toBe('PONG');
    const tables =
      (await h.low.send(new ListTablesCommand({}))).TableNames ?? [];
    expect(tables).toEqual(expect.arrayContaining(Object.values(h.tables)));
    expect(await h.redis.dbSize()).toBe(0);
  } finally {
    await h.cleanup();
  }
});

it('bootstraps Local tables idempotently without accessing AWS', async () => {
  const h = await harness();
  try {
    const env = {
      ...process.env,
      DYNAMODB_ENDPOINT: h.config.get<string>('dynamodb.endpoint')!,
      DYNAMODB_NOTIFICATIONS_TABLE: h.tables.notificationsTable,
      DYNAMODB_PUSH_SUBSCRIPTIONS_TABLE: h.tables.pushSubscriptionsTable,
      DYNAMODB_EVENT_STATE_TABLE: h.tables.eventStateTable,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const child = spawnSync(
        process.execPath,
        ['scripts/create-local-tables.mjs'],
        { env, encoding: 'utf8' },
      );
      expect(child.stderr).toBe('');
      expect(child.status).toBe(0);
    }
  } finally {
    await h.cleanup();
  }
});
