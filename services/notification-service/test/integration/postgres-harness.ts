import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { Pool } from 'pg';
import { PostgresDatabase } from '../../src/persistence/postgres.database.js';
import { migrate } from '../../src/persistence/schema.js';

export async function postgresHarness() {
  const connectionString =
    process.env.NOTIFICATION_TEST_DATABASE_URL ??
    'postgres://wgo:wgo@127.0.0.1:5432/wgo_notification';
  if (
    !['127.0.0.1', 'localhost', '[::1]'].includes(
      new URL(connectionString).hostname,
    )
  )
    throw new Error('Integration tests require a loopback PostgreSQL endpoint');
  const schema = `notification_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new Pool({ connectionString, connectionTimeoutMillis: 2000 });
  admin.on('error', () => undefined);
  await admin.query(`CREATE SCHEMA ${schema}`);
  const database = new PostgresDatabase(
    new ConfigService({
      database: {
        connectionString,
        options: `-c search_path=${schema}`,
        max: 10,
        connectionTimeoutMillis: 2000,
        statement_timeout: 10000,
        lock_timeout: 5000,
      },
    }),
  );
  async function cleanup() {
    await database.onApplicationShutdown();
    await admin.query(`DROP SCHEMA ${schema} CASCADE`);
    await admin.end();
  }
  try {
    await migrate(database.pool);
  } catch (error) {
    await cleanup();
    throw error;
  }
  return { database, schema, cleanup };
}
