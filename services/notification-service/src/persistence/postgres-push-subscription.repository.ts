import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PushSubscriptionRepository } from '../push-subscription/push-subscription.repository.js';
import type { PushSubscription } from '../push-subscription/push-subscription.js';
import { PostgresDatabase } from './postgres.database.js';

const digest = (token: string) =>
  createHash('sha256').update(token).digest('hex');
interface SubscriptionRow {
  user_id: string;
  token: string;
  platform: PushSubscription['platform'];
  created_at: string;
  updated_at: string;
  last_seen_at: string;
}
function fromRow(row: SubscriptionRow): PushSubscription {
  return {
    userId: row.user_id,
    token: row.token,
    platform: row.platform,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastSeenAt: row.last_seen_at,
  };
}
@Injectable()
export class PostgresPushSubscriptionRepository
  implements PushSubscriptionRepository
{
  constructor(private readonly database: PostgresDatabase) {}
  async upsert(input: PushSubscription): Promise<PushSubscription> {
    // A token has one owner across all users, including simultaneous registrations.
    const result = await this.database.pool.query<SubscriptionRow>(
      `INSERT INTO push_subscriptions
      (token_hash,user_id,token,platform,created_at,updated_at,last_seen_at) VALUES ($1,$2,$3,$4,$5,$6,$7)
      ON CONFLICT (token_hash) DO UPDATE SET platform=EXCLUDED.platform,
      updated_at=EXCLUDED.updated_at,last_seen_at=EXCLUDED.last_seen_at
      WHERE push_subscriptions.user_id=EXCLUDED.user_id AND push_subscriptions.token=EXCLUDED.token RETURNING *`,
      [
        digest(input.token),
        input.userId,
        input.token,
        input.platform,
        input.createdAt,
        input.updatedAt,
        input.lastSeenAt,
      ],
    );
    if (!result.rows[0])
      throw new Error('Token already belongs to another user');
    return fromRow(result.rows[0]);
  }
  async remove(userId: string, token: string): Promise<void> {
    await this.database.pool.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND token_hash=$2 AND token=$3',
      [userId, digest(token), token],
    );
  }
  async list(userId: string): Promise<PushSubscription[]> {
    const result = await this.database.pool.query<SubscriptionRow>(
      'SELECT * FROM push_subscriptions WHERE user_id=$1 ORDER BY token COLLATE "C"',
      [userId],
    );
    return result.rows.map(fromRow);
  }
  async removeTokens(userId: string, tokens: string[]): Promise<void> {
    await this.database.pool.query(
      'DELETE FROM push_subscriptions WHERE user_id=$1 AND token_hash=ANY($2::text[])',
      [userId, [...new Set(tokens)].map(digest)],
    );
  }
}
