import type { PoolClient } from 'pg';
import type { PostEvent } from '../event-consumer/post-event.js';
import type { NotificationEventWriter } from './notification-event.writer.js';

export async function confirmedPostNotifications(
  client: PoolClient,
  event: PostEvent,
  writer: NotificationEventWriter,
  previous: { closed: boolean; paused: boolean; post_version: number },
  now: Date,
) {
  const terminal =
    event.eventType === 'PostExpired' || event.eventType === 'PostDeleted';
  const update =
    event.eventType === 'PostUpdated' &&
    (event.postVersion ?? 0) > previous.post_version &&
    !previous.closed;
  if (terminal || (update && event.closedAt !== null))
    await client.query(
      `UPDATE notification_nearby_jobs SET status='CANCELED',lease_id=NULL,lease_until=NULL WHERE post_id=$1 AND status IN ('PENDING','RUNNING')`,
      [event.aggregateId],
    );
  if (terminal || update)
    await client.query(
      `UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL
    WHERE post_id=$1 AND status IN ('PENDING','SENDING') AND message->'data'->>'type' IN ('POST_CLOSED','POST_REOPENED')`,
      [event.aggregateId],
    );
  if (terminal || (update && event.closedAt !== null))
    await client.query(
      `UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL
    WHERE post_id=$1 AND status IN ('PENDING','SENDING') AND COALESCE(message->'data'->>'allowTerminal','false')<>'true'`,
      [event.aggregateId],
    );
  const sanction =
    ['PostDeleted', 'PostCommentDeleted'].includes(event.eventType) &&
    event.actorType === 'MODERATION' &&
    event.reason === 'MODERATION_VIOLATION';
  if (sanction) {
    const recipient =
      event.eventType === 'PostDeleted'
        ? event.postAuthorId
        : (event.commentAuthorId ?? event.actorId);
    if (!recipient) throw new Error('Confirmed sanction author missing');
    await writer.write(
      client,
      {
        stream: 'post:events',
        eventId: event.eventId,
        businessKey: `sanction:${event.eventType}:${event.commentId ?? event.aggregateId}`,
        userId: recipient,
        postId: event.aggregateId,
        type: 'CONTENT_REMOVED',
        title: '콘텐츠 삭제 안내',
        body: '운영 정책에 따라 콘텐츠가 삭제되었습니다.',
        category: 'moderation',
        push: true,
        allowTerminal: true,
        actionPath: '/notifications',
      },
      now,
    );
  }
  const expired =
    event.eventType === 'PostExpired' && !previous.closed && !previous.paused;
  const toggled = update && previous.paused !== (event.closedAt !== null);
  if ((expired || toggled) && event.postAuthorId) {
    const closed = expired || event.closedAt !== null;
    await writer.write(
      client,
      {
        stream: 'post:events',
        eventId: event.eventId,
        businessKey: `post-state:${event.aggregateId}:${event.postVersion}`,
        userId: event.postAuthorId,
        postId: event.aggregateId,
        type: closed ? 'POST_CLOSED' : 'POST_REOPENED',
        title: closed ? '게시물 종료' : '게시물 다시 열림',
        body: closed ? '게시물이 종료되었습니다.' : '게시물이 다시 열렸습니다.',
        category: 'lifecycle',
        push: true,
        allowTerminal: true,
        metadata: {
          postVersion: event.postVersion,
          confirmedAt: event.occurredAt,
        },
      },
      now,
    );
  }
}
