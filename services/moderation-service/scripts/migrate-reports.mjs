import { readFile } from 'node:fs/promises';
import pg from 'pg';
if (!process.env.MODERATION_REPORTS_DATABASE_URL)
  throw new Error('MODERATION_REPORTS_DATABASE_URL is required');
const pool = new pg.Pool({
  connectionString: process.env.MODERATION_REPORTS_DATABASE_URL,
  connectionTimeoutMillis: 3000,
});
try {
  await pool.query(
    await readFile(
      new URL('../migrations/001-reports.sql', import.meta.url),
      'utf8',
    ),
  );
} finally {
  await pool.end();
}
