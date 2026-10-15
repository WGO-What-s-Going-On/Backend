import type { ReactionType } from '../lifecycle/lifecycle.js';

export type PostEventType =
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
  aggregateId: string;
  eventType: PostEventType;
  schemaVersion: 1;
  producer: 'post-service';
  correlationId: string;
  occurredAt: string;
  activityVersion?: number;
  postVersion?: number;
  post?: { postId: string };
  comment?: {
    commentId: string;
    postId: string;
    authorId: number;
    content?: string;
  };
  reaction?: {
    postId: string;
    userId: number;
    type: ReactionType;
    createdAt: string;
    removedAt?: string;
  };
  participant?: { postId: string; userId: number };
}
const eventTypes = new Set<PostEventType>([
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
const reactionTypes = new Set([
  'CURIOUS',
  'STILL_HAPPENING',
  'HELPFUL',
  'ENDED',
  'LIKE',
]);
const text = (v: unknown): v is string =>
  typeof v === 'string' && v.trim().length > 0;
const date = (v: unknown): v is string =>
  text(v) &&
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/.test(v) &&
  Number.isFinite(Date.parse(v));
const version = (v: unknown): v is number =>
  typeof v === 'number' && Number.isSafeInteger(v) && v > 0;
export function parsePostEvent(
  fields: Record<string, string>,
): PostEvent | null {
  if (!fields.data) throw new Error('Invalid post event: missing data');
  let value: unknown;
  try {
    value = JSON.parse(fields.data);
  } catch {
    throw new Error('Invalid post event JSON');
  }
  if (!record(value)) throw new Error('Invalid post event envelope');
  if (
    typeof value.eventType !== 'string' ||
    !eventTypes.has(value.eventType as PostEventType)
  )
    return null;
  if (
    !text(value.eventId) ||
    value.eventId !== fields.eventId ||
    value.eventType !== fields.eventType ||
    value.schemaVersion !== 1 ||
    value.producer !== 'post-service' ||
    !text(value.aggregateId) ||
    !text(value.correlationId) ||
    !date(value.occurredAt) ||
    (value.activityVersion !== undefined && !version(value.activityVersion)) ||
    (value.postVersion !== undefined && !version(value.postVersion)) ||
    (value.postAuthorId !== undefined && !version(value.postAuthorId))
  )
    throw new Error('Invalid post event envelope');
  const type = value.eventType as PostEventType;
  const requiredActivityVersion = [
    'PostReactionRemoved',
    'PostCommentDeleted',
    'PostParticipantLeft',
  ].includes(type);
  if (
    requiredActivityVersion &&
    (!version(value.activityVersion) || !version(value.postAuthorId))
  )
    throw new Error('Invalid activity context');
  if (
    ['PostDeleted', 'PostExpired'].includes(type) &&
    !version(value.postVersion)
  )
    throw new Error('Invalid postVersion');
  const payload = type.startsWith('PostReaction')
    ? value.reaction
    : type.startsWith('PostComment')
      ? value.comment
      : type.startsWith('PostParticipant')
        ? value.participant
        : value.post;
  if (!record(payload) || payload.postId !== value.aggregateId)
    throw new Error(`Invalid ${type} payload`);
  if (
    type.startsWith('PostReaction') &&
    (!version(payload.userId) ||
      typeof payload.type !== 'string' ||
      !reactionTypes.has(payload.type) ||
      !date(payload.createdAt) ||
      Date.parse(payload.createdAt) > Date.parse(value.occurredAt) ||
      (type === 'PostReactionRemoved' && !date(payload.removedAt)))
  )
    throw new Error(`Invalid ${type} payload`);
  if (
    type.startsWith('PostComment') &&
    (!text(payload.commentId) ||
      !version(payload.authorId) ||
      (type === 'PostCommentCreated' &&
        (!text(payload.content) || payload.content.length > 2000)) ||
      (type === 'PostCommentDeleted' && !date(payload.deletedAt)))
  )
    throw new Error(`Invalid ${type} payload`);
  if (type.startsWith('PostParticipant') && !version(payload.userId))
    throw new Error(`Invalid ${type} payload`);
  if (type === 'PostDeleted' && !date(payload.deletedAt))
    throw new Error(`Invalid ${type} payload`);
  if (
    type === 'PostExpired' &&
    (!date(payload.expiredAt) || !date(payload.expiresAt))
  )
    throw new Error(`Invalid ${type} payload`);
  if (
    type === 'PostParticipantLeft' &&
    (!date(payload.joinedAt) || !date(payload.leftAt))
  )
    throw new Error(`Invalid ${type} payload`);
  if (type === 'PostDeleted' || type === 'PostCommentDeleted') {
    const actor = value.actor;
    if (
      !record(actor) ||
      !(
        (actor.type === 'USER' &&
          version(actor.userId) &&
          value.reason === 'USER_REQUEST') ||
        (actor.type === 'MODERATION' &&
          actor.userId === null &&
          value.reason === 'MODERATION_VIOLATION' &&
          text(value.moderationDecisionId))
      )
    )
      throw new Error('Invalid deletion actor/reason');
  }
  // v1 생성 이벤트의 추가 문맥/버전은 선택적이며, 해석에 필요한 최상위 도메인 객체를 보존한다.
  return value as unknown as PostEvent;
}
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
