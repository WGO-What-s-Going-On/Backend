import {
  Injectable,
  BadRequestException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { nearbyEnabled, LOCATION_TTL_MS } from './nearby.policy.js';
@Injectable()
export class NearbySubscriptionService {
  constructor(private readonly database: PostgresDatabase) {}
  async get(userId: string) {
    const row = (
      await this.database.pool.query(
        'SELECT expires_at FROM notification_nearby_subscriptions WHERE user_id=$1 AND expires_at>now()',
        [userId],
      )
    ).rows[0];
    return {
      featureEnabled: nearbyEnabled(),
      enabled: !!row,
      locationConsent: !!row,
      expiresAt: row ? new Date(row.expires_at).toISOString() : null,
      radiusM: 150,
    };
  }
  async remove(userId: string) {
    await this.database.transaction(async (client) => {
      // The row lock also serializes a concurrent fanout enqueue with withdrawal.
      await client.query(
        'DELETE FROM notification_nearby_subscriptions WHERE user_id=$1',
        [userId],
      );
      await client.query(
        `UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL WHERE message->>'userId'=$1 AND message->'data'->>'category'='nearby' AND status IN ('PENDING','SENDING')`,
        [userId],
      );
    });
  }
  async save(userId: string, raw: unknown, now = new Date()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw))
      throw new BadRequestException('Explicit location subscription required');
    const b = raw as Record<string, unknown>;
    if (b.enabled === false && Object.keys(b).length === 1) {
      await this.remove(userId);
      return this.get(userId);
    }
    if (!nearbyEnabled())
      throw new ServiceUnavailableException(
        'Nearby notifications are disabled',
      );
    if (
      Object.keys(b).some(
        (k) =>
          ![
            'enabled',
            'locationConsent',
            'latitude',
            'longitude',
            'capturedAt',
            'expiresInSeconds',
          ].includes(k),
      ) ||
      b.enabled !== true ||
      b.locationConsent !== true ||
      typeof b.latitude !== 'number' ||
      !Number.isFinite(b.latitude) ||
      Math.abs(b.latitude) > 90 ||
      typeof b.longitude !== 'number' ||
      !Number.isFinite(b.longitude) ||
      Math.abs(b.longitude) > 180 ||
      typeof b.capturedAt !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(b.capturedAt) ||
      !Number.isFinite(Date.parse(b.capturedAt))
    )
      throw new BadRequestException(
        'Opt-in and separate location consent with valid coordinates are required',
      );
    const captured = Date.parse(b.capturedAt),
      seconds = b.expiresInSeconds ?? 900;
    if (
      typeof seconds !== 'number' ||
      !Number.isInteger(seconds) ||
      seconds < 60 ||
      seconds > 900 ||
      captured > now.getTime() + 30000 ||
      captured <= now.getTime() - LOCATION_TTL_MS
    )
      throw new BadRequestException(
        'Fresh location and TTL of 60..900 seconds required',
      );
    const expires = new Date(
      Math.min(now.getTime() + seconds * 1000, captured + LOCATION_TTL_MS),
    );
    await this.database.transaction(async (client) => {
      await client.query(
        `INSERT INTO notification_nearby_subscriptions(user_id,revision,latitude,longitude,captured_at,expires_at) VALUES($1,$2,$3,$4,$5,$6)
    ON CONFLICT(user_id) DO UPDATE SET revision=EXCLUDED.revision,latitude=EXCLUDED.latitude,longitude=EXCLUDED.longitude,captured_at=EXCLUDED.captured_at,expires_at=EXCLUDED.expires_at`,
        [userId, randomUUID(), b.latitude, b.longitude, b.capturedAt, expires],
      );
      await client.query(
        `UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL WHERE message->>'userId'=$1 AND message->'data'->>'category'='nearby' AND status IN ('PENDING','SENDING')`,
        [userId],
      );
    });
    return this.get(userId);
  }
}
