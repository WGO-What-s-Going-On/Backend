import { BadRequestException, Injectable } from '@nestjs/common';
import type { Pool, PoolClient } from 'pg';
import type {
  Notification,
  NotificationPage,
} from '../notification/notification.js';
import type { NotificationRepository } from '../notification/notification.repository.js';
import { PostgresDatabase } from './postgres.database.js';

export interface NotificationRow {
  user_id: string;
  notification_id: string;
  data: Omit<
    Notification,
    'userId' | 'notificationId' | 'count' | 'isRead' | 'expiresAt'
  >;
  count: number;
  is_read: boolean;
  expires_at: string;
  deleted_at: Date | null;
}
export function notificationFromRow(row: NotificationRow): Notification {
  return {
    ...row.data,
    userId: row.user_id,
    notificationId: row.notification_id,
    count: row.count,
    isRead: row.is_read,
    expiresAt: Number(row.expires_at),
  };
}
export async function insertNotification(
  client: Pool | PoolClient,
  notification: Notification,
): Promise<boolean> {
  const { userId, notificationId, count, isRead, expiresAt, ...data } =
    notification;
  const result = await client.query(
    `INSERT INTO notifications
    (user_id, notification_id, data, count, is_read, expires_at) VALUES ($1,$2,$3,$4,$5,$6)
    ON CONFLICT DO NOTHING`,
    [userId, notificationId, data, count, isRead, expiresAt],
  );
  return result.rowCount === 1;
}
@Injectable()
export class PostgresNotificationRepository implements NotificationRepository {
  constructor(private readonly database: PostgresDatabase) {}
  async create(notification: Notification): Promise<boolean> {
    return insertNotification(this.database.pool, notification);
  }
  async list(
    userId: string,
    limit: number,
    cursor?: string,
  ): Promise<NotificationPage> {
    if (!Number.isInteger(limit) || limit < 1 || limit > 100)
      throw new BadRequestException('invalid limit');
    const before = cursor ? decodeCursor(cursor) : null;
    const result = await this.database.pool.query<NotificationRow>(
      `SELECT * FROM notifications
      WHERE user_id=$1 AND count > 0 AND deleted_at IS NULL AND expires_at > $2
      AND ($3::text IS NULL OR notification_id < $3 COLLATE "C")
      ORDER BY notification_id DESC LIMIT $4`,
      [userId, Math.floor(Date.now() / 1000), before, limit + 1],
    );
    const items = result.rows.slice(0, limit).map(notificationFromRow);
    const last = items.at(-1);
    return {
      items,
      ...(result.rows.length > limit && last
        ? { nextCursor: encodeCursor(last.notificationId) }
        : {}),
    };
  }
  async markRead(
    userId: string,
    notificationId: string,
  ): Promise<Notification | null> {
    const result = await this.database.pool.query<NotificationRow>(
      `UPDATE notifications SET is_read=true
      WHERE user_id=$1 AND notification_id=$2 RETURNING *`,
      [userId, notificationId],
    );
    return result.rows[0] ? notificationFromRow(result.rows[0]) : null;
  }
  async remove(userId: string, notificationId: string): Promise<void> {
    await this.database.pool.query(
      'UPDATE notifications SET deleted_at=now(), is_read=true WHERE user_id=$1 AND notification_id=$2',
      [userId, notificationId],
    );
  }
  async increment(
    userId: string,
    notificationId: string,
  ): Promise<Notification | null> {
    const result = await this.database.pool.query<NotificationRow>(
      `UPDATE notifications SET count=count+1
      WHERE user_id=$1 AND notification_id=$2 AND deleted_at IS NULL RETURNING *`,
      [userId, notificationId],
    );
    return result.rows[0] ? notificationFromRow(result.rows[0]) : null;
  }
  async countUnread(userId: string): Promise<number> {
    const result = await this.database.pool.query<{ count: string }>(
      `SELECT count(*) FROM notifications
      WHERE user_id=$1 AND NOT is_read AND count > 0 AND deleted_at IS NULL AND expires_at > $2`,
      [userId, Math.floor(Date.now() / 1000)],
    );
    return Number(result.rows[0]?.count ?? 0);
  }
}
function encodeCursor(id: string): string {
  return Buffer.from(id, 'utf8').toString('base64url');
}
function decodeCursor(cursor: string): string {
  const id = Buffer.from(cursor, 'base64url').toString('utf8');
  if (!id || !/^[A-Za-z0-9_-]+$/.test(cursor) || encodeCursor(id) !== cursor)
    throw new BadRequestException('invalid cursor');
  return id;
}
