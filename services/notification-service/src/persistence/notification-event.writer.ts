import { Injectable } from '@nestjs/common';
import type { PoolClient } from 'pg';
import { PostgresDatabase } from './postgres.database.js';
import { insertNotification } from './postgres-notification.repository.js';
import type { Notification } from '../notification/notification.js';

export interface EventNotification {
  stream: string;
  businessKey: string;
  eventId: string;
  userId: string;
  type: string;
  title: string;
  body: string;
  category: string;
  push: boolean;
  postId?: string;
  actorId?: string;
  commentId?: string;
  parentCommentId?: string;
  metadata?: Record<string, unknown>;
  actionPath?: string;
  allowTerminal?: boolean;
}
@Injectable()
export class NotificationEventWriter {
  constructor(readonly database: PostgresDatabase) {}
  async record(
    stream: string,
    eventId: string,
    details: Record<string, unknown>,
    work: (client: PoolClient) => Promise<string[]>,
  ): Promise<string[]> {
    return this.database.transaction(async (client) => {
      await client.query(
        'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
        [`${stream}:${eventId}`],
      );
      if (
        (
          await client.query(
            'SELECT 1 FROM notification_event_inbox WHERE source_stream=$1 AND event_id=$2',
            [stream, eventId],
          )
        ).rowCount
      )
        return [];
      const recipients = await work(client);
      await client.query(
        'INSERT INTO notification_event_inbox(source_stream,event_id,details) VALUES($1,$2,$3)',
        [stream, eventId, details],
      );
      return recipients;
    });
  }
  async write(
    client: PoolClient,
    input: EventNotification,
    now = new Date(),
  ): Promise<{ notificationId: string; created: boolean } | null> {
    const settings =
      (
        await client.query(
          'SELECT settings FROM notification_preferences WHERE user_id=$1',
          [input.userId],
        )
      ).rows[0]?.settings ?? {};
    if (settings[input.category] === false) return null;
    if (
      input.postId &&
      (
        await client.query(
          'SELECT enabled FROM notification_board_preferences WHERE user_id=$1 AND post_id=$2',
          [input.userId, input.postId],
        )
      ).rows[0]?.enabled === false
    )
      return null;
    const notificationId = `${now.toISOString()}_${input.eventId}_${input.type}_${input.userId}`;
    const claimed = await client.query(
      `INSERT INTO notification_business_keys(source_stream,business_key,recipient,notification_id)
      VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING RETURNING notification_id`,
      [input.stream, input.businessKey, input.userId, notificationId],
    );
    if (!claimed.rowCount) {
      const old = (
        await client.query(
          'SELECT notification_id FROM notification_business_keys WHERE source_stream=$1 AND business_key=$2 AND recipient=$3',
          [input.stream, input.businessKey, input.userId],
        )
      ).rows[0];
      return old
        ? { notificationId: old.notification_id, created: false }
        : null;
    }
    const notification: Notification = {
      notificationId,
      userId: input.userId,
      type: input.type,
      title: input.title,
      body: input.body,
      actorId: input.actorId ?? null,
      targetType: input.postId ? 'post' : 'user',
      targetId: input.postId ?? input.userId,
      actionPath:
        input.actionPath ??
        (input.postId ? `/posts/${input.postId}` : '/notifications'),
      count: 1,
      isRead: false,
      createdAt: now.toISOString(),
      expiresAt: Math.floor(now.getTime() / 1000) + 2592000,
      ...(input.commentId ? { commentId: input.commentId } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    };
    if (!(await insertNotification(client, notification)))
      throw new Error('Notification identity conflict');
    if (input.push) {
      const data: Record<string, string> = {
        notificationId,
        type: input.type,
        category: input.category,
      };
      if (input.commentId) data.commentId = input.commentId;
      if (input.parentCommentId) data.parentCommentId = input.parentCommentId;
      if (input.actorId) data.actorId = input.actorId;
      if (input.allowTerminal) data.allowTerminal = 'true';
      for (const [key, value] of Object.entries(input.metadata ?? {}))
        if (typeof value === 'string' || typeof value === 'number')
          data[key] = String(value);
      await client.query(
        `INSERT INTO notification_deliveries(scope_id,post_id,key,status,message) VALUES($1,$2,$3,'PENDING',$4)`,
        [
          `${input.stream}:${input.businessKey}:${input.userId}`,
          input.postId ?? null,
          `delivery#${notificationId}`,
          {
            userId: input.userId,
            title: input.title,
            body: input.body,
            targetId: notification.targetId,
            actionPath: notification.actionPath,
            data,
          },
        ],
      );
    }
    return { notificationId, created: true };
  }
}
