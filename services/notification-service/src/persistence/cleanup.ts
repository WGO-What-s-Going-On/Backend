import { createLogger } from '../observability/logging.js';
const logger = createLogger('notification-service', 'retention');
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
  logger.success(
    'notification_retention_completed',
    'Expired notifications removed',
    { count: result.rowCount ?? 0 },
  );
} catch (error) {
  logger.failure(
    'notification_retention_failed',
    error,
    'RETENTION_FAILED',
    'Notification retention cleanup failed',
    {},
    true,
  );
  process.exitCode = 1;
} finally {
  await pool.end();
}
