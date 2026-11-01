import { Pool } from 'pg';
import { postgresConfig } from './postgres.config.js';
import { migrate } from './schema.js';

const pool = new Pool(postgresConfig());
try {
  await migrate(pool);
  console.info('Notification PostgreSQL migrations completed');
} catch {
  console.error('Notification PostgreSQL migration failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
