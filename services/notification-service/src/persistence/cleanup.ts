import { Pool } from 'pg';
import { postgresConfig } from './postgres.config.js';

const pool = new Pool(postgresConfig());
try {
  // Keep event markers and tombstones. Expiring those could make a replay count twice.
  const result = await pool.query(
    `DELETE FROM notifications WHERE (user_id,notification_id) IN (
    SELECT user_id,notification_id FROM notifications WHERE expires_at <= $1
    ORDER BY expires_at LIMIT 1000 FOR UPDATE SKIP LOCKED
  )`,
    [Math.floor(Date.now() / 1000)],
  );
  console.info(`Expired notifications removed: ${result.rowCount ?? 0}`);
} catch {
  console.error('Notification retention cleanup failed');
  process.exitCode = 1;
} finally {
  await pool.end();
}
