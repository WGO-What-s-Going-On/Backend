import type { PoolClient } from 'pg';
import type { PostEvent } from '../event-consumer/post-event.js';
export const nearbyEnabled = () =>
  process.env.NEARBY_NOTIFICATIONS_ENABLED === 'true';
export const LOCATION_TTL_MS = 900000;
export function distanceM(
  lat1: number,
  lon1: number,
  lat2: number,
  lon2: number,
) {
  const rad = Math.PI / 180,
    a =
      Math.sin(((lat2 - lat1) * rad) / 2) ** 2 +
      Math.cos(lat1 * rad) *
        Math.cos(lat2 * rad) *
        Math.sin(((lon2 - lon1) * rad) / 2) ** 2;
  return (
    6371000 *
    2 *
    Math.atan2(Math.sqrt(Math.min(1, a)), Math.sqrt(Math.max(0, 1 - a)))
  );
}
export async function scheduleNearby(client: PoolClient, event: PostEvent) {
  if (
    !nearbyEnabled() ||
    event.eventType !== 'PostCreated' ||
    event.latitude === undefined ||
    event.longitude === undefined ||
    !event.postAuthorId
  )
    return;
  const expires = new Date(Date.parse(event.occurredAt) + LOCATION_TTL_MS);
  if (
    expires.getTime() <= Date.now() ||
    Date.parse(event.occurredAt) > Date.now() + 30000
  )
    return;
  await client.query(
    `INSERT INTO notification_nearby_jobs(post_id,event_id,author_id,latitude,longitude,expires_at)
  SELECT post_id,$2,$3,$4,$5,$6 FROM notification_posts WHERE post_id=$1 AND NOT closed AND NOT paused ON CONFLICT DO NOTHING`,
    [
      event.aggregateId,
      event.eventId,
      event.postAuthorId,
      event.latitude,
      event.longitude,
      expires,
    ],
  );
}
