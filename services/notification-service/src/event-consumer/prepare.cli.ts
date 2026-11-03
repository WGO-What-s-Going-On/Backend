import { ConfigService } from '@nestjs/config';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { postgresConfig } from '../persistence/postgres.config.js';
import { DurableStreamConsumer } from './durable-stream.consumer.js';
import { deadStreams } from './replay.js';
const groups: Record<string, string> = {
  'post:events': 'post-notification',
  'user:events': 'user-notification',
  'moderation:events': 'moderation-notification',
  'moderation:report-events': 'moderation-report-notification',
  'moderation:content-events': 'moderation-content-notification',
};
if (!process.env.REDIS_URL) throw new Error('REDIS_URL required');
const database = new PostgresDatabase(
  new ConfigService({ database: postgresConfig() }),
);
try {
  if (
    (
      await database.pool.query(
        'SELECT 1 FROM notification_schema_versions WHERE version=4',
      )
    ).rowCount !== 1
  )
    throw new Error('Required schema missing');
  for (const [stream, group] of Object.entries(groups)) {
    const consumer = new DurableStreamConsumer(
      database,
      { stream, group, dead: deadStreams[stream]!, url: process.env.REDIS_URL },
      async () => {
        throw new Error('Prepare must never consume');
      },
    );
    try {
      await consumer.initialize();
      console.info(JSON.stringify({ prepared: stream, group }));
    } finally {
      await consumer.onModuleDestroy();
    }
  }
} catch {
  console.error(
    'Notification stream preparation failed; existing groups preserved',
  );
  process.exitCode = 1;
} finally {
  await database.onApplicationShutdown();
}
