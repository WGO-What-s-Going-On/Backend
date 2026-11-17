import type { PoolClient } from 'pg';
export async function migrateNearbyMap(client: PoolClient) {
  if (
    (
      await client.query(
        'SELECT 1 FROM notification_schema_versions WHERE version=5',
      )
    ).rowCount
  )
    return;
  // Preserve all existing job/subscription columns and rows; unknown legacy radii are not guessed.
  await client.query(`CREATE TABLE notification_nearby_job_policy (
    post_id text PRIMARY KEY REFERENCES notification_nearby_jobs(post_id) ON DELETE CASCADE,
    participation_radius_m double precision NOT NULL CHECK(participation_radius_m BETWEEN 1 AND 10000));
    INSERT INTO notification_schema_versions VALUES(5);`);
}
