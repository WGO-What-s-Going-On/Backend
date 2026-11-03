import type { Pool } from 'pg';
import { migrateCrossService } from './cross-service.schema.js';

export async function migrate(pool: Pool): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // Deployment retries must not run two schema migrations concurrently.
    await client.query(
      "SELECT pg_advisory_xact_lock(hashtext(current_database()), hashtext('notification-schema'))",
    );
    await client.query(`
      CREATE TABLE IF NOT EXISTS notification_schema_versions (version integer PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS notifications (
        user_id text NOT NULL,
        notification_id text COLLATE "C" NOT NULL,
        data jsonb NOT NULL,
        count integer NOT NULL CHECK (count >= 0),
        is_read boolean NOT NULL,
        expires_at bigint NOT NULL,
        deleted_at timestamptz,
        PRIMARY KEY (user_id, notification_id)
      );
      CREATE INDEX IF NOT EXISTS notifications_inbox ON notifications (user_id, notification_id DESC)
        WHERE deleted_at IS NULL AND count > 0;
      CREATE INDEX IF NOT EXISTS notifications_expiry ON notifications (expires_at);
      CREATE TABLE IF NOT EXISTS push_subscriptions (
        token_hash text PRIMARY KEY,
        user_id text NOT NULL,
        token text NOT NULL,
        platform text NOT NULL CHECK (platform IN ('web', 'ios', 'android')),
        created_at text NOT NULL,
        updated_at text NOT NULL,
        last_seen_at text NOT NULL
      );
      CREATE INDEX IF NOT EXISTS push_subscriptions_user ON push_subscriptions (user_id, token COLLATE "C");
      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id text PRIMARY KEY,
        settings jsonb NOT NULL DEFAULT '{}'
      );
      CREATE TABLE IF NOT EXISTS notification_board_preferences (
        user_id text NOT NULL,
        post_id text NOT NULL,
        enabled boolean NOT NULL,
        PRIMARY KEY (user_id, post_id)
      );
      CREATE TABLE IF NOT EXISTS notification_posts (
        post_id text PRIMARY KEY,
        revision integer NOT NULL DEFAULT 0,
        author_id text,
        closed boolean NOT NULL DEFAULT false,
        post_version integer NOT NULL DEFAULT 0,
        terminal_type text
      );
      CREATE TABLE IF NOT EXISTS notification_processed_events (
        post_id text NOT NULL REFERENCES notification_posts(post_id),
        event_id text NOT NULL,
        recipient text,
        details jsonb NOT NULL,
        PRIMARY KEY (post_id, event_id)
      );
      CREATE TABLE IF NOT EXISTS notification_activities (
        post_id text NOT NULL REFERENCES notification_posts(post_id),
        activity_key text NOT NULL,
        version integer NOT NULL,
        active boolean NOT NULL,
        terminal boolean NOT NULL DEFAULT false,
        notification_id text,
        recipient text,
        PRIMARY KEY (post_id, activity_key)
      );
      CREATE TABLE IF NOT EXISTS notification_bundle_windows (
        post_id text NOT NULL REFERENCES notification_posts(post_id),
        recipient text NOT NULL,
        type text NOT NULL,
        notification_id text NOT NULL,
        until_ms bigint NOT NULL,
        PRIMARY KEY (post_id, recipient, type)
      );
      CREATE TABLE IF NOT EXISTS notification_deliveries (
        post_id text NOT NULL REFERENCES notification_posts(post_id),
        key text NOT NULL,
        status text NOT NULL CHECK (status IN ('PENDING', 'SENDING', 'SENT', 'CANCELED', 'FAILED')),
        message jsonb NOT NULL,
        attempts integer NOT NULL DEFAULT 0,
        lease_id text,
        lease_until bigint,
        next_attempt_at bigint NOT NULL DEFAULT 0,
        PRIMARY KEY (post_id, key),
        CHECK ((status = 'SENDING') = (lease_id IS NOT NULL AND lease_until IS NOT NULL))
      );
      CREATE INDEX IF NOT EXISTS notification_deliveries_due ON notification_deliveries (next_attempt_at, post_id, key)
        WHERE status IN ('PENDING', 'SENDING');
      INSERT INTO notification_schema_versions (version) VALUES (1) ON CONFLICT DO NOTHING;
    `);
    await migrateCrossService(client);
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}
