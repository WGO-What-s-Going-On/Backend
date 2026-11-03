import { createLogger } from '../observability/logging.js';
import { Injectable } from '@nestjs/common';
import { NotificationEventWriter } from '../persistence/notification-event.writer.js';
import { NotificationState } from '../redis/notification-state.js';
import { PostEventHandler } from './post-event.handler.js';
import { parseModerationEvent } from './moderation-event.js';

@Injectable()
export class ModerationEventHandler {
  private readonly logger = createLogger(
    'notification-service',
    'notification',
  );
  constructor(
    private readonly writer: NotificationEventWriter,
    private readonly state: NotificationState,
    private readonly deliveries: PostEventHandler,
  ) {}
  async handle(stream: string, fields: Record<string, string>) {
    const event = parseModerationEvent(fields, stream),
      p = event.data;
    const recipients = await this.writer.record(
      stream,
      event.eventId,
      { eventType: event.eventType },
      async (client) => {
        if (stream === 'moderation:content-events') return [];
        const report = stream === 'moderation:report-events';
        if (report) {
          // No real admin review producer exists. Unknown/review-shaped facts cannot assert completion.
          if (!['REPORT_CREATED', 'REPORT_WITHDRAWN'].includes(event.eventType))
            return [];
          const n = await this.writer.write(client, {
            stream,
            eventId: event.eventId,
            businessKey: `${event.eventType}:${p.reportId}`,
            userId: event.recipient!,
            type: event.eventType,
            title:
              event.eventType === 'REPORT_CREATED' ? '신고 접수' : '신고 취소',
            body:
              event.eventType === 'REPORT_CREATED'
                ? '신고가 접수되었습니다. 검토 완료를 의미하지 않습니다.'
                : '신고가 취소되었습니다.',
            category: 'moderation',
            push: false,
            metadata: { reportId: p.reportId, targetType: p.targetType },
            actionPath: '/notifications',
          });
          return n?.created ? [event.recipient!] : [];
        }
        if (
          !['BOARD_STALE', 'BOARD_REACTIVATED', 'BOARD_CLOSED'].includes(
            event.eventType,
          ) ||
          typeof p.version !== 'number'
        )
          return [];
        await client.query(
          'INSERT INTO notification_posts(post_id) VALUES($1) ON CONFLICT DO NOTHING',
          [event.postId],
        );
        const post = (
          await client.query(
            'SELECT * FROM notification_posts WHERE post_id=$1 FOR UPDATE',
            [event.postId],
          )
        ).rows[0];
        const current = (
          await client.query(
            'SELECT version FROM notification_lifecycle_states WHERE post_id=$1',
            [event.postId],
          )
        ).rows[0];
        if (current && Number(current.version) >= p.version) return [];
        await client.query(
          `INSERT INTO notification_lifecycle_states(post_id,version,state,scheduled_close_at,event_id) VALUES($1,$2,$3,$4,$5)
        ON CONFLICT(post_id) DO UPDATE SET version=EXCLUDED.version,state=EXCLUDED.state,scheduled_close_at=EXCLUDED.scheduled_close_at,event_id=EXCLUDED.event_id`,
          [
            event.postId,
            p.version,
            p.state,
            p.scheduledCloseAt ?? null,
            event.eventId,
          ],
        );
        // Cancel the previous warning on reactivation/close or a newer STALE transition.
        await client.query(
          `UPDATE notification_deliveries SET status='CANCELED',lease_id=NULL,lease_until=NULL
        WHERE post_id=$1 AND message->'data'->>'type'='BOARD_STALE' AND status IN ('PENDING','SENDING')`,
          [event.postId],
        );
        if (post.closed || post.paused || event.eventType === 'BOARD_CLOSED')
          return [];
        const recipient = event.recipient ?? post.author_id;
        if (!recipient) return [];
        if (
          event.recipient &&
          post.author_id &&
          event.recipient !== post.author_id
        )
          throw new Error('Invalid lifecycle author conflict');
        const stale = event.eventType === 'BOARD_STALE';
        if (stale && typeof p.scheduledCloseAt !== 'string') return [];
        const n = await this.writer.write(client, {
          stream,
          eventId: event.eventId,
          businessKey: `lifecycle:${event.postId}:${p.version}`,
          userId: recipient,
          postId: event.postId!,
          type: event.eventType,
          title: stale ? '게시물 종료 예정' : '게시물 활동 재개',
          body: stale
            ? '게시물이 종료 유예 상태로 전환되었습니다.'
            : '새 활동으로 게시물의 종료 유예가 해제되었습니다.',
          category: 'lifecycle',
          push: !stale || Date.parse(String(p.scheduledCloseAt)) > Date.now(),
          metadata: {
            lifecycleVersion: p.version,
            ...(stale ? { scheduledCloseAt: p.scheduledCloseAt } : {}),
          },
        });
        return n?.created ? [recipient] : [];
      },
    );
    this.logger.success(
      'notification_event_committed',
      'Notification event receipt committed',
      {
        eventId: event.eventId,
        eventType: event.eventType,
        count: recipients.length,
      },
    );
    for (const userId of recipients) await this.state.invalidateUnread(userId);
    await this.deliveries.dispatch();
  }
}
