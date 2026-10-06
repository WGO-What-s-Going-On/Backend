export type PostEventType =
  | 'PostCreated'
  | 'PostCommentCreated'
  | 'PostReactionCreated'
  | 'PostParticipantJoined';

export interface PostEvent {
  eventId: string;
  aggregateId: string;
  eventType: PostEventType;
  schemaVersion: 1;
  producer: 'post-service';
  correlationId: string;
  occurredAt: string;
  post?: { postId: string };
  comment?: {
    commentId: string;
    postId: string;
    authorId: number;
    content: string;
  };
}

const eventTypes = new Set<PostEventType>([
  'PostCreated',
  'PostCommentCreated',
  'PostReactionCreated',
  'PostParticipantJoined',
]);

export function parsePostEvent(
  fields: Record<string, string>,
): PostEvent | null {
  if (!fields.data) throw new Error('Invalid post event: missing data');
  let value: Record<string, unknown>;
  try {
    value = JSON.parse(fields.data) as Record<string, unknown>;
  } catch {
    throw new Error('Invalid post event JSON');
  }
  if (
    typeof value.eventType !== 'string' ||
    !eventTypes.has(value.eventType as PostEventType)
  )
    return null;
  if (
    typeof value.eventId !== 'string' ||
    value.eventId !== fields.eventId ||
    value.eventType !== fields.eventType ||
    value.schemaVersion !== 1 ||
    value.producer !== 'post-service' ||
    typeof value.aggregateId !== 'string' ||
    typeof value.correlationId !== 'string' ||
    typeof value.occurredAt !== 'string'
  )
    throw new Error('Invalid post event envelope');

  const event: PostEvent = {
    eventId: value.eventId,
    aggregateId: value.aggregateId,
    eventType: value.eventType as PostEventType,
    schemaVersion: 1,
    producer: 'post-service',
    correlationId: value.correlationId,
    occurredAt: value.occurredAt,
  };
  if (event.eventType === 'PostCreated') {
    if (!record(value.post) || typeof value.post.postId !== 'string')
      throw new Error('Invalid PostCreated payload');
    event.post = { postId: value.post.postId };
  }
  if (event.eventType === 'PostCommentCreated') {
    if (
      !record(value.comment) ||
      typeof value.comment.commentId !== 'string' ||
      typeof value.comment.postId !== 'string' ||
      typeof value.comment.authorId !== 'number' ||
      typeof value.comment.content !== 'string'
    )
      throw new Error('Invalid PostCommentCreated payload');
    event.comment = {
      commentId: value.comment.commentId,
      postId: value.comment.postId,
      authorId: value.comment.authorId,
      content: value.comment.content,
    };
  }
  return event;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
