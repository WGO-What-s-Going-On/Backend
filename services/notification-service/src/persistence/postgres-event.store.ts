import { Injectable, Optional } from '@nestjs/common';
import { NotificationBlockChecker } from '../notification/block-checker.js';
import { NotificationEventWriter } from './notification-event.writer.js';
import { projectExtendedPost } from './extended-post.notifications.js';
import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import type { PostEvent } from '../event-consumer/post-event.js';
import type { Notification } from '../notification/notification.js';
import type { PushMessage } from '../firebase/push.js';
import { PostgresDatabase } from './postgres.database.js';
import {
  insertNotification,
  notificationFromRow,
  type NotificationRow,
} from './postgres-notification.repository.js';

interface PostState {
  revision: number;
  author_id: string | null;
  closed: boolean;
  paused: boolean;
  post_version: number;
  terminal_type: string | null;
}
interface Activity {
  version: number;
  active: boolean;
  notification_id: string | null;
  recipient: string | null;
  terminal: boolean;
}
interface Preferences {
  nearby: boolean;
  replies: boolean;
  reactions: boolean;
  lifecycle: boolean;
  rewards: boolean;
  votes: boolean;
  moderation: boolean;
}
interface ProcessedEvent {
  recipient: string | null;
  details: {
    eventType: string;
    occurredAt: string;
    correlationId?: string;
    reason?: string;
    actorType?: string;
  };
}
export interface Delivery {
  postId: string | null;
  scopeId?: string;
  key: string;
  status: 'PENDING' | 'SENDING' | 'SENT' | 'CANCELED' | 'FAILED';
  message: PushMessage;
  leaseId?: string;
  leaseUntil?: number;
  nextAttemptAt?: number;
  attempts: number;
}
interface DeliveryRow {
  post_id: string | null;
  scope_id: string;
  key: string;
  status: Delivery['status'];
  message: PushMessage;
  lease_id: string | null;
  lease_until: string | null;
  next_attempt_at: string;
  attempts: number;
}
const deliveryFromRow = (row: DeliveryRow): Delivery => ({
  postId: row.post_id,
  scopeId: row.scope_id,
  key: row.key,
  status: row.status,
  message: row.message,
  attempts: row.attempts,
  nextAttemptAt: Number(row.next_attempt_at),
  ...(row.lease_id ? { leaseId: row.lease_id } : {}),
  ...(row.lease_until ? { leaseUntil: Number(row.lease_until) } : {}),
});
export class BusyDeliveryError extends Error {
  constructor() {
    super('Delivery is busy; keep event pending');
  }
}

@Injectable()
export class PostgresEventStore {
  constructor(
    private readonly database: PostgresDatabase,
    @Optional() private readonly blocks?: NotificationBlockChecker,
  ) {}

  async postState(postId: string): Promise<PostState | undefined> {
    return (
      await this.database.pool.query<PostState>(
        'SELECT * FROM notification_posts WHERE post_id=$1',
        [postId],
      )
    ).rows[0];
  }
  async processedEvent(postId: string, eventId: string) {
    const row = (
      await this.database.pool.query<ProcessedEvent>(
        'SELECT * FROM notification_processed_events WHERE post_id=$1 AND event_id=$2',
        [postId, eventId],
      )
    ).rows[0];
    return row ? { ...row.details, recipient: row.recipient } : undefined;
  }
  async delivery(postId: string, key: string): Promise<Delivery | undefined> {
    const row = (
      await this.database.pool.query<DeliveryRow>(
        'SELECT * FROM notification_deliveries WHERE post_id=$1 AND key=$2',
        [postId, key],
      )
    ).rows[0];
    return row ? deliveryFromRow(row) : undefined;
  }
  async preferences(
    userId: string,
    client: Pool | PoolClient = this.database.pool,
  ): Promise<Preferences> {
    const row = (
      await client.query<{ settings: Partial<Preferences> }>(
        'SELECT settings FROM notification_preferences WHERE user_id=$1',
        [userId],
      )
    ).rows[0];
    return {
      nearby: true,
      replies: true,
      reactions: true,
      lifecycle: true,
      rewards: true,
      votes: true,
      moderation: true,
      ...row?.settings,
    };
  }
  async savePreferences(
    userId: string,
    input: Record<string, boolean>,
  ): Promise<Preferences> {
    await this.database.pool.query(
      `INSERT INTO notification_preferences (user_id,settings) VALUES ($1,$2)
      ON CONFLICT (user_id) DO UPDATE SET settings=notification_preferences.settings || EXCLUDED.settings`,
      [userId, input],
    );
    return this.preferences(userId);
  }
  async boardPreference(
    userId: string,
    postId: string,
    client: Pool | PoolClient = this.database.pool,
  ) {
    const row = (
      await client.query<{ enabled: boolean }>(
        'SELECT enabled FROM notification_board_preferences WHERE user_id=$1 AND post_id=$2',
        [userId, postId],
      )
    ).rows[0];
    return { postId, enabled: row?.enabled ?? true };
  }
  async setBoardPreference(userId: string, postId: string, enabled: boolean) {
    await this.database.pool.query(
      `INSERT INTO notification_board_preferences (user_id,post_id,enabled) VALUES ($1,$2,$3)
      ON CONFLICT (user_id,post_id) DO UPDATE SET enabled=EXCLUDED.enabled`,
      [userId, postId, enabled],
    );
    return { postId, enabled };
  }
  async allowed(
    userId: string,
    postId: string | null,
    type: string,
    client: Pool | PoolClient = this.database.pool,
  ) {
    const preferences = await this.preferences(userId, client);
    const board = postId
      ? await this.boardPreference(userId, postId, client)
      : { enabled: true };
    const key: keyof Preferences = [
      'nearby',
      'replies',
      'reactions',
      'lifecycle',
      'rewards',
      'votes',
      'moderation',
    ].includes(type)
      ? (type as keyof Preferences)
      : type === 'PostCommentCreated' || type === 'POST_COMMENTED'
        ? 'replies'
        : type === 'PostReactionCreated' || type === 'POST_REACTED'
          ? 'reactions'
          : type === 'POST_CREATED'
            ? 'nearby'
            : 'lifecycle';
    return board.enabled && preferences[key];
  }
  private async lockPost(
    client: PoolClient,
    postId: string,
  ): Promise<PostState> {
    await client.query(
      'INSERT INTO notification_posts (post_id) VALUES ($1) ON CONFLICT DO NOTHING',
      [postId],
    );
    const result = await client.query<PostState>(
      'SELECT * FROM notification_posts WHERE post_id=$1 FOR UPDATE',
      [postId],
    );
    const row = result.rows[0];
    if (!row) throw new Error('Notification post state missing');
    return row;
  }

  async apply(event: PostEvent, now = new Date()): Promise<string | undefined> {
    let allowedRecipients: Set<string> | undefined;
    if (
      event.eventType === 'PostCommentCreated' &&
      event.parentCommentId &&
      !event.parentCommentAuthorId
    ) {
      const parent = (
        await this.database.pool.query(
          'SELECT author_id FROM notification_comment_states WHERE post_id=$1 AND comment_id=$2',
          [event.aggregateId, event.parentCommentId],
        )
      ).rows[0];
      if (!parent?.author_id)
        throw new Error(
          'Parent comment author unavailable; recipient reconciliation required',
        );
      event = { ...event, parentCommentAuthorId: parent.author_id };
    }
    if (
      this.blocks &&
      [
        'PostCommentCreated',
        'PostReactionCreated',
        'PostCommentReactionCreated',
      ].includes(event.eventType)
    ) {
      const owner =
        event.postAuthorId ??
        (await this.postState(event.aggregateId))?.author_id;
      const recipients =
        event.eventType === 'PostCommentReactionCreated'
          ? [event.commentAuthorId]
          : [owner, event.parentCommentAuthorId];
      allowedRecipients = new Set<string>();
      // Network authorization is outside the transaction; delivery checks it again before sending.
      for (const recipient of new Set(recipients))
        if (
          recipient &&
          event.actorId &&
          recipient !== event.actorId &&
          (await this.blocks.allowed(recipient, event.actorId))
        )
          allowedRecipients.add(recipient);
    }
    return this.database.transaction(async (client) => {
      const postId = event.aggregateId;
      // 동일 post의 중복 처리와 묶음 갱신은 이 행 잠금과 같은 transaction 안에서 직렬화한다.
      const meta = await this.lockPost(client, postId);
      const processed = (
        await client.query<{ recipient: string | null }>(
          'SELECT recipient FROM notification_processed_events WHERE post_id=$1 AND event_id=$2',
          [postId, event.eventId],
        )
      ).rows[0];
      if (processed) return processed.recipient ?? undefined;
      const recipient = event.postAuthorId ?? meta.author_id ?? undefined;
      const terminal =
        event.eventType === 'PostDeleted' || event.eventType === 'PostExpired';
      if (terminal) {
        meta.closed = true;
        if ((event.postVersion ?? 0) >= meta.post_version) {
          meta.post_version = event.postVersion ?? 1;
          meta.terminal_type = event.eventType;
        }
      } else if (
        event.eventType === 'PostCreated' &&
        event.postVersion !== undefined
      ) {
        meta.post_version = Math.max(meta.post_version, event.postVersion);
      }
      if (
        event.eventType === 'PostUpdated' &&
        !meta.closed &&
        (event.postVersion ?? 0) > meta.post_version
      ) {
        meta.post_version = event.postVersion!;
        meta.paused = event.closedAt !== null;
      }
      const extended = await projectExtendedPost(
        client,
        event,
        meta,
        new NotificationEventWriter(this.database),
        allowedRecipients,
        now,
      );
      if (
        !extended &&
        event.activityKey &&
        !meta.closed &&
        !meta.paused &&
        event.eventType !== 'PostCommentUpdated'
      ) {
        const previous = (
          await client.query<Activity>(
            'SELECT * FROM notification_activities WHERE post_id=$1 AND activity_key=$2',
            [postId, event.activityKey],
          )
        ).rows[0];
        const version = event.activityVersion ?? 1;
        const active =
          event.eventType === 'PostCommentCreated' ||
          event.eventType === 'PostReactionCreated';
        if (!previous || (version > previous.version && !previous.terminal)) {
          let notificationId: string | undefined;
          let activityRecipient: string | undefined;
          if (
            active &&
            recipient !== event.actorId &&
            (!allowedRecipients ||
              (!!recipient && allowedRecipients.has(recipient))) &&
            (!recipient ||
              (await this.allowed(recipient, postId, event.eventType, client)))
          ) {
            if (!recipient)
              throw new Error(
                'Legacy post author unavailable; recipient reconciliation required',
              );
            const type =
              event.eventType === 'PostCommentCreated'
                ? 'POST_COMMENTED'
                : 'POST_REACTED';
            const window = (
              await client.query<{ notification_id: string; until_ms: string }>(
                `SELECT notification_id,until_ms FROM notification_bundle_windows
              WHERE post_id=$1 AND recipient=$2 AND type=$3`,
                [postId, recipient, type],
              )
            ).rows[0];
            let existing: Notification | undefined;
            if (window && Number(window.until_ms) > now.getTime()) {
              const row = (
                await client.query<NotificationRow>(
                  'SELECT * FROM notifications WHERE user_id=$1 AND notification_id=$2 FOR UPDATE',
                  [recipient, window.notification_id],
                )
              ).rows[0];
              if (
                row &&
                row.count > 0 &&
                Number(row.expires_at) > now.getTime() / 1000
              )
                existing = notificationFromRow(row);
            }
            if (existing) {
              notificationId = existing.notificationId;
              await client.query(
                'UPDATE notifications SET count=count+1 WHERE user_id=$1 AND notification_id=$2',
                [recipient, notificationId],
              );
            } else {
              notificationId = `${now.toISOString()}_${event.eventId}_${recipient}`;
              const notification: Notification = {
                notificationId,
                userId: recipient,
                type,
                title: type === 'POST_COMMENTED' ? '새 댓글' : '새 공감',
                body:
                  type === 'POST_COMMENTED'
                    ? '게시물에 새 댓글이 달렸습니다.'
                    : '게시물에 새로운 반응이 있습니다.',
                actorId: event.actorId ?? null,
                targetType: 'post',
                targetId: postId,
                actionPath: `/posts/${postId}`,
                count: 1,
                isRead: false,
                createdAt: now.toISOString(),
                expiresAt: Math.floor(now.getTime() / 1000) + 2592000,
                ...(event.commentId ? { commentId: event.commentId } : {}),
              };
              if (!(await insertNotification(client, notification)))
                throw new Error('Notification identity conflict');
              await client.query(
                `INSERT INTO notification_bundle_windows (post_id,recipient,type,notification_id,until_ms) VALUES ($1,$2,$3,$4,$5)
                ON CONFLICT (post_id,recipient,type) DO UPDATE SET notification_id=EXCLUDED.notification_id,until_ms=EXCLUDED.until_ms`,
                [
                  postId,
                  recipient,
                  type,
                  notificationId,
                  now.getTime() + 120000,
                ],
              );
              const message: PushMessage = {
                userId: recipient,
                title: notification.title,
                body: notification.body,
                targetId: postId,
                actionPath: notification.actionPath,
                data: {
                  notificationId,
                  type,
                  ...(event.actorId ? { actorId: event.actorId } : {}),
                  ...(event.commentId ? { commentId: event.commentId } : {}),
                },
              };
              await client.query(
                `INSERT INTO notification_deliveries (post_id,key,status,message) VALUES ($1,$2,'PENDING',$3)`,
                [postId, `delivery#${notificationId}`, message],
              );
            }
            activityRecipient = recipient;
          } else if (
            !active &&
            previous?.active &&
            previous.notification_id &&
            previous.recipient
          ) {
            // 활동 tombstone을 남겨 늦게 도착한 생성 이벤트가 다시 집계되지 않게 한다.
            const row = (
              await client.query<NotificationRow>(
                'SELECT * FROM notifications WHERE user_id=$1 AND notification_id=$2 FOR UPDATE',
                [previous.recipient, previous.notification_id],
              )
            ).rows[0];
            const removedReference =
              !!event.commentId && row?.data.commentId === event.commentId;
            if (row && row.count > 0) {
              await client.query(
                `UPDATE notifications SET count=count-1, data=CASE WHEN $3 THEN data-'commentId' ELSE data END
                WHERE user_id=$1 AND notification_id=$2 AND count>0`,
                [
                  previous.recipient,
                  previous.notification_id,
                  removedReference,
                ],
              );
            }
            if (removedReference)
              await client.query(
                `UPDATE notification_deliveries SET message=message #- '{data,commentId}'
              WHERE post_id=$1 AND key=$2 AND status='PENDING'`,
                [postId, `delivery#${previous.notification_id}`],
              );
          }
          await client.query(
            `INSERT INTO notification_activities (post_id,activity_key,version,active,terminal,notification_id,recipient)
            VALUES ($1,$2,$3,$4,$5,$6,$7) ON CONFLICT (post_id,activity_key) DO UPDATE SET
            version=EXCLUDED.version,active=EXCLUDED.active,terminal=EXCLUDED.terminal,notification_id=EXCLUDED.notification_id,recipient=EXCLUDED.recipient`,
            [
              postId,
              event.activityKey,
              version,
              active,
              event.eventType === 'PostCommentDeleted',
              notificationId ?? null,
              activityRecipient ?? null,
            ],
          );
        }
      }
      await client.query(
        `UPDATE notification_posts SET revision=revision+1,author_id=$2,closed=$3,post_version=$4,terminal_type=$5,paused=$6 WHERE post_id=$1`,
        [
          postId,
          recipient ?? null,
          meta.closed,
          meta.post_version,
          meta.terminal_type,
          meta.paused,
        ],
      );
      await client.query(
        `INSERT INTO notification_processed_events (post_id,event_id,recipient,details) VALUES ($1,$2,$3,$4)`,
        [
          postId,
          event.eventId,
          recipient ?? null,
          {
            eventType: event.eventType,
            occurredAt: event.occurredAt,
            correlationId: event.correlationId,
            reason: event.reason,
            actorType: event.actorType,
          },
        ],
      );
      await client.query(
        `INSERT INTO notification_event_inbox(source_stream,event_id,details) VALUES('post:events',$1,$2)
        ON CONFLICT DO NOTHING`,
        [event.eventId, { eventType: event.eventType }],
      );
      return recipient;
    });
  }

  async deliveries(postId?: string): Promise<Delivery[]> {
    // 복구 batch에는 실행 가능한 작업만 넣어 다른 worker의 lease가 후속 작업을 막지 않게 한다.
    const result = await this.database.pool.query<DeliveryRow>(
      `SELECT * FROM notification_deliveries
      WHERE status IN ('PENDING','SENDING') AND ($1::text IS NULL OR post_id=$1)
      AND ($1::text IS NOT NULL OR (next_attempt_at<=$2 AND (status='PENDING' OR lease_until<=$2)))
      ORDER BY next_attempt_at,post_id,key LIMIT 100`,
      [postId ?? null, Date.now()],
    );
    return result.rows.map(deliveryFromRow);
  }
  async acquire(
    delivery: Delivery,
    now = new Date(),
  ): Promise<Delivery | undefined> {
    return this.database.transaction(async (client) => {
      const meta = delivery.postId
        ? await this.lockPost(client, delivery.postId)
        : undefined;
      const scopeId = delivery.scopeId ?? `post:${delivery.postId}`;
      if (!meta)
        await client.query(
          'SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
          [scopeId],
        );
      const current = (
        await client.query<DeliveryRow>(
          'SELECT * FROM notification_deliveries WHERE scope_id=$1 AND key=$2 FOR UPDATE',
          [scopeId, delivery.key],
        )
      ).rows[0];
      if (
        !current ||
        !['PENDING', 'SENDING'].includes(current.status) ||
        Number(current.next_attempt_at) > now.getTime() ||
        (current.status === 'SENDING' &&
          Number(current.lease_until) > now.getTime())
      )
        throw new BusyDeliveryError();
      const notificationId = current.message.data?.notificationId;
      const notification = notificationId
        ? (
            await client.query<NotificationRow>(
              'SELECT * FROM notifications WHERE user_id=$1 AND notification_id=$2 FOR UPDATE',
              [current.message.userId, notificationId],
            )
          ).rows[0]
        : undefined;
      const cancel =
        ((meta?.closed || meta?.paused) &&
          current.message.data?.allowTerminal !== 'true') ||
        !notification ||
        notification.count <= 0 ||
        !!notification.deleted_at ||
        Number(notification.expires_at) <= now.getTime() / 1000;
      if (cancel) {
        await client.query(
          "UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL WHERE scope_id=$1 AND key=$2",
          [scopeId, delivery.key],
        );
        return undefined;
      }
      const result = await client.query<DeliveryRow>(
        `UPDATE notification_deliveries SET status='SENDING',lease_id=$3,lease_until=$4,attempts=attempts+1
        WHERE scope_id=$1 AND key=$2 RETURNING *`,
        [scopeId, delivery.key, randomUUID(), now.getTime() + 60000],
      );
      const row = result.rows[0];
      if (!row) throw new BusyDeliveryError();
      return deliveryFromRow(row);
    });
  }
  async finish(
    delivery: Delivery,
    status: 'SENT' | 'FAILED' | 'PENDING' | 'CANCELED',
    retryTokens?: string[],
    now = new Date(),
  ): Promise<void> {
    const message = {
      ...delivery.message,
      ...(retryTokens ? { tokens: retryTokens } : {}),
    };
    const result = await this.database.pool.query(
      `UPDATE notification_deliveries SET status=$4,message=$5,next_attempt_at=$6,lease_id=NULL,lease_until=NULL
      WHERE scope_id=$1 AND key=$2 AND status='SENDING' AND lease_id=$3`,
      [
        delivery.scopeId ?? `post:${delivery.postId}`,
        delivery.key,
        delivery.leaseId ?? null,
        status,
        message,
        now.getTime() +
          Math.min(300000, 1000 * 2 ** Math.min(delivery.attempts, 8)),
      ],
    );
    if (result.rowCount !== 1) throw new BusyDeliveryError();
  }
}
