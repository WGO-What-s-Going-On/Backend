import type { PoolClient } from 'pg';
export async function migrateNearby(client: PoolClient) {
  if (
    (
      await client.query(
        'SELECT 1 FROM notification_schema_versions WHERE version=4',
      )
    ).rowCount
  )
    return;
  await client.query(`CREATE TABLE notification_nearby_subscriptions(
  user_id text PRIMARY KEY,revision text NOT NULL,latitude double precision NOT NULL CHECK(latitude BETWEEN -90 AND 90),
  longitude double precision NOT NULL CHECK(longitude BETWEEN -180 AND 180),captured_at timestamptz NOT NULL,expires_at timestamptz NOT NULL);
  CREATE INDEX notification_nearby_location ON notification_nearby_subscriptions(latitude,longitude,user_id);
  CREATE TABLE notification_nearby_limits(user_id text PRIMARY KEY,last_enqueued_at timestamptz NOT NULL);
  CREATE TABLE notification_nearby_jobs(post_id text PRIMARY KEY REFERENCES notification_posts(post_id),event_id text NOT NULL,
  author_id text NOT NULL,latitude double precision NOT NULL,longitude double precision NOT NULL,expires_at timestamptz NOT NULL,
  cursor_user_id text NOT NULL DEFAULT '',status text NOT NULL DEFAULT 'PENDING' CHECK(status IN ('PENDING','RUNNING','DONE','CANCELED')),
  lease_id text,lease_until timestamptz,next_attempt_at timestamptz NOT NULL DEFAULT now());
  CREATE INDEX notification_nearby_jobs_due ON notification_nearby_jobs(next_attempt_at) WHERE status IN ('PENDING','RUNNING');
  INSERT INTO notification_schema_versions VALUES(4);`);
}
