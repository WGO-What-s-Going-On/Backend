import {
  check,
  natural,
  object,
  text,
  time,
  uid,
  wire,
} from './event-validation.js';
export interface ModerationNotificationEvent {
  eventId: string;
  eventType: string;
  occurredAt: string;
  postId?: string;
  recipient?: string;
  data: Record<string, unknown>;
}
export function parseModerationEvent(
  fields: Record<string, string>,
  stream: string,
): ModerationNotificationEvent {
  const v = wire(fields);
  check(
    text(v.eventType) &&
      v.eventType === fields.eventType &&
      v.schemaVersion === 1 &&
      v.producer === 'moderation-service' &&
      time(v.occurredAt),
    'Moderation envelope',
  );
  const result: ModerationNotificationEvent = {
    eventId: String(v.eventId),
    eventType: v.eventType,
    occurredAt: String(v.occurredAt),
    data: {},
  };
  if (stream === 'moderation:report-events') {
    check(
      object(v.data) &&
        text(v.data.reportId) &&
        uid(v.data.reporterUserId) &&
        ['POST', 'COMMENT'].includes(String(v.data.targetType)) &&
        text(v.data.postId),
      'report context',
    );
    if (v.data.targetType === 'COMMENT')
      check(text(v.data.commentId), 'report comment');
    if (v.eventType === 'REPORT_CREATED')
      check(
        [
          'SPAM',
          'HARASSMENT',
          'INAPPROPRIATE_CONTENT',
          'FALSE_INFORMATION',
          'OTHER',
        ].includes(String(v.data.reason)),
        'report reason',
      );
    if (v.eventType === 'REPORT_WITHDRAWN')
      check(time(v.data.withdrawnAt), 'report withdrawal');
    result.recipient = v.data.reporterUserId;
    result.postId = v.data.postId;
    result.data = v.data;
  } else if (stream === 'moderation:events') {
    check(
      object(v.payload) &&
        text(v.aggregateId) &&
        v.payload.postId === v.aggregateId &&
        ['ACTIVE', 'STALE', 'CLOSED'].includes(String(v.payload.state)),
      'lifecycle context',
    );
    if (v.payload.version !== undefined)
      check(
        natural(v.payload.version) && v.payload.version > 0,
        'lifecycle version',
      );
    if (v.payload.postAuthorId !== undefined)
      check(uid(v.payload.postAuthorId), 'lifecycle author');
    if (
      v.payload.scheduledCloseAt !== undefined &&
      v.payload.scheduledCloseAt !== null
    )
      check(time(v.payload.scheduledCloseAt), 'lifecycle close time');
    const states: Record<string, string> = {
      BOARD_STALE: 'STALE',
      BOARD_REACTIVATED: 'ACTIVE',
      BOARD_CLOSED: 'CLOSED',
    };
    if (states[v.eventType])
      check(states[v.eventType] === v.payload.state, 'lifecycle transition');
    result.postId = String(v.aggregateId);
    result.data = v.payload;
    if (uid(v.payload.postAuthorId)) result.recipient = v.payload.postAuthorId;
  } else if (stream === 'moderation:content-events') {
    check(
      v.eventType === 'CONTENT_MODERATION_EVALUATED' &&
        typeof v.flagged === 'boolean' &&
        text(v.postId) &&
        text(v.commentId),
      'AI evaluation',
    );
    // An AI observation never becomes a sanction or report-review notification.
    result.postId = v.postId;
  } else throw new Error('Invalid Moderation stream');
  return result;
}
