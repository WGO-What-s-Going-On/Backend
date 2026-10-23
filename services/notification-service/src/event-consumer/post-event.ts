export type SupportedPostEventType =
  | 'PostCreated'
  | 'PostCommentCreated'
  | 'PostReactionCreated'
  | 'PostParticipantJoined'
  | 'PostReactionRemoved'
  | 'PostCommentDeleted'
  | 'PostDeleted'
  | 'PostParticipantLeft'
  | 'PostExpired';
export interface PostEvent {
  eventId: string;
  eventType: SupportedPostEventType;
  schemaVersion: 1;
  producer: 'post-service';
  aggregateId: string;
  correlationId: string;
  occurredAt: string;
  actorId?: string;
  postAuthorId?: string;
  activityKey?: string;
  activityVersion?: number;
  postVersion?: number;
  commentId?: string;
  reason?: string;
  actorType?: string;
}
const supported = new Set<SupportedPostEventType>([
  'PostCreated',
  'PostCommentCreated',
  'PostReactionCreated',
  'PostParticipantJoined',
  'PostReactionRemoved',
  'PostCommentDeleted',
  'PostDeleted',
  'PostParticipantLeft',
  'PostExpired',
]);
const reactions = new Set([
  'CURIOUS',
  'STILL_HAPPENING',
  'HELPFUL',
  'ENDED',
  'LIKE',
]);
const record = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string =>
  typeof value === 'string' && value.trim().length > 0;
const positive = (value: unknown): value is number =>
  typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const date = (value: unknown): value is string =>
  typeof value === 'string' &&
  /^\d{4}-\d{2}-\d{2}T.*Z$/.test(value) &&
  Number.isFinite(Date.parse(value));
function require(value: unknown, message: string): asserts value {
  if (!value) throw new Error(`Invalid ${message}`);
}
export function parsePostEvent(
  raw: string,
  fields?: Record<string, string>,
): PostEvent | null {
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new Error('Invalid post event JSON');
  }
  require(record(value), 'post event envelope');
  if (
    !text(value.eventType) ||
    !supported.has(value.eventType as SupportedPostEventType)
  )
    return null;
  require(text(value.eventId) &&
    value.schemaVersion === 1 &&
    value.producer === 'post-service' &&
    text(value.aggregateId) &&
    text(value.correlationId) &&
    date(value.occurredAt), 'post event envelope');
  if (fields)
    require(fields.eventId === value.eventId &&
      fields.eventType === value.eventType, 'stream envelope identifiers');
  for (const key of ['activityVersion', 'postVersion'])
    if (value[key] !== undefined)
      require(positive(value[key]), 'post event version');
  if (value.postAuthorId !== undefined)
    require(positive(value.postAuthorId), 'post author ID');
  const event: PostEvent = {
    eventId: value.eventId as string,
    eventType: value.eventType as SupportedPostEventType,
    schemaVersion: 1,
    producer: 'post-service',
    aggregateId: value.aggregateId as string,
    correlationId: value.correlationId as string,
    occurredAt: value.occurredAt as string,
  };
  if (value.postAuthorId !== undefined)
    event.postAuthorId = String(value.postAuthorId);
  if (value.activityVersion !== undefined)
    event.activityVersion = value.activityVersion as number;
  if (value.postVersion !== undefined)
    event.postVersion = value.postVersion as number;
  const type = event.eventType;
  const removed = [
    'PostReactionRemoved',
    'PostCommentDeleted',
    'PostParticipantLeft',
  ].includes(type);
  if (removed)
    require(positive(value.activityVersion) &&
      positive(value.postAuthorId) &&
      text(value.postCategory), 'activity context');
  if (['PostCreated', 'PostDeleted', 'PostExpired'].includes(type)) {
    require(record(value.post) &&
      value.post.postId === event.aggregateId &&
      positive(value.post.authorId) &&
      text(value.post.category), 'post payload');
    event.postAuthorId = String(value.post.authorId);
    if (type === 'PostCreated')
      require(typeof value.post.latitude === 'number' &&
        Number.isFinite(value.post.latitude) &&
        typeof value.post.longitude === 'number' &&
        Number.isFinite(value.post.longitude) &&
        typeof value.post.radiusM === 'number' &&
        value.post.radiusM > 0 &&
        value.post.expiresAt === null, 'created post payload');
    else {
      require(positive(value.postVersion), 'post version');
      require(date(
        type === 'PostDeleted' ? value.post.deletedAt : value.post.expiredAt,
      ), 'terminal post time');
    }
    if (type === 'PostExpired')
      require(date(value.post.expiresAt), 'post expiry time');
  }
  if (['PostCommentCreated', 'PostCommentDeleted'].includes(type)) {
    require(record(value.comment) &&
      text(value.comment.commentId) &&
      value.comment.postId === event.aggregateId &&
      positive(value.comment.authorId), 'comment event');
    if (type === 'PostCommentCreated')
      require(typeof value.comment.content === 'string' &&
        value.comment.status === 'ACTIVE' &&
        date(value.comment.createdAt) &&
        value.comment.updatedAt === null, 'created comment payload');
    else require(date(value.comment.deletedAt), 'deleted comment payload');
    event.actorId = String(value.comment.authorId);
    event.commentId = value.comment.commentId;
    event.activityKey = `comment#${event.commentId}`;
  }
  if (['PostReactionCreated', 'PostReactionRemoved'].includes(type)) {
    require(record(value.reaction) &&
      value.reaction.postId === event.aggregateId &&
      positive(value.reaction.userId) &&
      typeof value.reaction.type === 'string' &&
      reactions.has(value.reaction.type) &&
      date(value.reaction.createdAt), 'reaction event');
    if (removed)
      require(date(value.reaction.removedAt), 'removed reaction payload');
    event.actorId = String(value.reaction.userId);
    event.activityKey = `reaction#${event.actorId}#${value.reaction.type}`;
  }
  if (['PostParticipantJoined', 'PostParticipantLeft'].includes(type)) {
    require(record(value.participant) &&
      value.participant.postId === event.aggregateId &&
      positive(value.participant.userId) &&
      date(value.participant.joinedAt), 'participant event');
    if (removed)
      require(date(value.participant.leftAt), 'left participant payload');
    else
      require(value.participant.leftAt === null &&
        date(value.participant.lastSeenAt), 'joined participant payload');
  }
  if (['PostDeleted', 'PostCommentDeleted'].includes(type)) {
    require(record(value.actor) &&
      ((value.actor.type === 'USER' &&
        positive(value.actor.userId) &&
        value.reason === 'USER_REQUEST') ||
        (value.actor.type === 'MODERATION' &&
          value.actor.userId === null &&
          value.reason === 'MODERATION_VIOLATION' &&
          text(value.moderationDecisionId) &&
          value.moderationDecisionId.length <= 128)), 'deletion actor/reason');
    event.reason = value.reason as string;
    event.actorType = value.actor.type as string;
  }
  return event;
}
