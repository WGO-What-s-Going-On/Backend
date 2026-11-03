import type { PoolClient } from 'pg';
export async function migratePostNotifications(client: PoolClient) {
  if (
    (
      await client.query(
        'SELECT 1 FROM notification_schema_versions WHERE version=3',
      )
    ).rowCount
  )
    return;
  await client.query(`ALTER TABLE notification_activities ADD COLUMN details jsonb NOT NULL DEFAULT '{}';
    ALTER TABLE notification_posts ADD COLUMN paused boolean NOT NULL DEFAULT false;
    CREATE INDEX notification_activity_comments ON notification_activities(post_id,(details->>'commentId'));
    CREATE INDEX notification_activity_parents ON notification_activities(post_id,(details->>'parentCommentId'));
    INSERT INTO notification_schema_versions VALUES(3);`);
}
