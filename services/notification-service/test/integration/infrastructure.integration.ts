import { expect, it } from 'vitest';
import { harness } from './harness.js';
import { migrate } from '../../src/persistence/schema.js';

it('connects to isolated PostgreSQL schema and Redis and repeats migration safely', async () => {
  const h = await harness();
  try {
    expect(await h.redis.ping()).toBe('PONG');
    await migrate(h.database.pool);
    await migrate(h.database.pool);
    expect(
      (
        await h.database.pool.query(
          'SELECT version FROM notification_schema_versions',
        )
      ).rows,
    ).toEqual([{ version: 1 }]);
    const tables = (
      await h.database.pool.query<{ tablename: string }>(
        'SELECT tablename FROM pg_tables WHERE schemaname=$1',
        [h.schema],
      )
    ).rows.map((x) => x.tablename);
    expect(tables).toEqual(
      expect.arrayContaining([
        'notifications',
        'push_subscriptions',
        'notification_deliveries',
      ]),
    );
    expect(await h.redis.dbSize()).toBe(0);
  } finally {
    await h.cleanup();
  }
});
