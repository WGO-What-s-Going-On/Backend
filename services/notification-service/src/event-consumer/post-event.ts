export type SupportedPostEventType =
  | 'PostCreated'
  | 'PostCommentCreated'
  | 'PostReactionCreated'
  | 'PostParticipantJoined';

export interface PostEvent {
  eventId: string;
  eventType: SupportedPostEventType;
  schemaVersion: 1;
  producer: 'post-service';
  aggregateId: string;
  occurredAt: string;
  actorId?: string;
}

const supported = new Set<SupportedPostEventType>([
  'PostCreated',
  'PostCommentCreated',
  'PostReactionCreated',
  'PostParticipantJoined',
]);

export function parsePostEvent(raw: string): PostEvent | null {
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid post event JSON');
  }
  if (typeof value.eventType !== 'string' || !supported.has(value.eventType as SupportedPostEventType)) return null;
  if (
    typeof value.eventId !== 'string' ||
    value.schemaVersion !== 1 ||
    value.producer !== 'post-service' ||
    typeof value.aggregateId !== 'string' ||
    typeof value.occurredAt !== 'string'
  ) throw new Error('Invalid post event envelope');

  let actorId: string | undefined;
  if (value.eventType === 'PostCommentCreated') {
    if (!isRecord(value.comment) || typeof value.comment.authorId !== 'number') throw new Error('Invalid comment event');
    actorId = String(value.comment.authorId);
  }
  if (value.eventType === 'PostReactionCreated') {
    if (!isRecord(value.reaction) || value.reaction.type !== 'LIKE' || typeof value.reaction.userId !== 'number') throw new Error('Invalid reaction event');
    actorId = String(value.reaction.userId);
  }
  return { eventId: value.eventId, eventType: value.eventType as SupportedPostEventType, schemaVersion: 1, producer: 'post-service', aggregateId: value.aggregateId, occurredAt: value.occurredAt, ...(actorId ? { actorId } : {}) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
