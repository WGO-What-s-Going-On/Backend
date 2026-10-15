import { ListTablesCommand } from '@aws-sdk/client-dynamodb';
import { expect, it } from 'vitest';
import { harness } from './harness.js';
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
