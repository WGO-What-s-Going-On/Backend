export class InvalidOutboxEvent extends Error {}

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = (value: unknown, prefix: string) =>
  typeof value === 'string' && new RegExp(`^${prefix}_${uuid}$`).test(value);
const user = (value: unknown) =>
  Number.isSafeInteger(value) && Number(value) > 0;
const date = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value));
const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value);
const category = (value: unknown) =>
  typeof value === 'string' && /^[A-Z][A-Z_]{0,39}$/.test(value);
const keys = [
  'eventId',
  'eventType',
  'schemaVersion',
  'producer',
  'aggregateId',
  'correlationId',
  'occurredAt',
];

// MongoDB의 mixed payload가 손상되었을 때 소비자 전체에 독성 메시지를 퍼뜨리지 않는다.
// 과거 v1의 선택 문맥 누락은 허용하지만 envelope 덮어쓰기와 대상 불일치는 격리한다.
export function serializePostEvent(row: Record<string, any>): string {
  try {
    if (!object(row.payload) || keys.some((key) => key in row.payload))
      throw new Error('Reserved envelope field in payload');
    const envelope = Object.fromEntries(keys.map((key) => [key, row[key]]));
    const data = JSON.stringify({ ...envelope, ...row.payload });
    const value = JSON.parse(data) as Record<string, any>;
    if (
      !id(value.eventId, 'evt') ||
      !id(value.aggregateId, 'post') ||
      value.producer !== 'post-service' ||
      value.schemaVersion !== 1 ||
      typeof value.correlationId !== 'string' ||
      !value.correlationId ||
      !date(value.occurredAt)
    )
      throw new Error('Invalid envelope');
    const types: Record<string, string> = {
      PostCreated: 'post',
      PostDeleted: 'post',
      PostExpired: 'post',
      PostCommentCreated: 'comment',
      PostCommentDeleted: 'comment',
      PostReactionCreated: 'reaction',
      PostReactionRemoved: 'reaction',
      PostParticipantJoined: 'participant',
      PostParticipantLeft: 'participant',
    };
    const key = types[value.eventType];
    const target = key ? value[key] : undefined;
    if (!object(target) || target.postId !== value.aggregateId)
      throw new Error('Invalid event type or target');
    if (!user(target.authorId ?? target.userId))
      throw new Error('Invalid actor ID');
    if (value.postAuthorId !== undefined && !user(value.postAuthorId))
      throw new Error('Invalid post author');
    if (value.postCategory !== undefined && !category(value.postCategory))
      throw new Error('Invalid post category');
    for (const version of ['activityVersion', 'postVersion']) {
      if (value[version] !== undefined && !user(value[version]))
        throw new Error('Invalid state version');
    }
    if (key === 'post' && !category(target.category))
      throw new Error('Invalid category');
    if (key === 'comment' && !id(target.commentId, 'comment'))
      throw new Error('Invalid comment ID');
    if (key === 'reaction' && target.type !== 'LIKE')
      throw new Error('Invalid reaction type');
    const requiredDates: Record<string, string[]> = {
      PostCreated: [],
      PostDeleted: ['deletedAt'],
      PostExpired: ['expiresAt', 'expiredAt'],
      PostCommentCreated: ['createdAt'],
      PostCommentDeleted: ['deletedAt'],
      PostReactionCreated: ['createdAt'],
      PostReactionRemoved: ['createdAt', 'removedAt'],
      PostParticipantJoined: ['joinedAt', 'lastSeenAt'],
      PostParticipantLeft: ['joinedAt', 'leftAt'],
    };
    if (requiredDates[value.eventType]!.some((field) => !date(target[field])))
      throw new Error('Invalid event timestamp');
    if (
      value.eventType === 'PostCreated' &&
      (!Number.isFinite(target.latitude) ||
        target.latitude < -90 ||
        target.latitude > 90 ||
        !Number.isFinite(target.longitude) ||
        target.longitude < -180 ||
        target.longitude > 180 ||
        !Number.isFinite(target.radiusM) ||
        target.radiusM < 1 ||
        target.radiusM > 10000 ||
        !(target.expiresAt === null || date(target.expiresAt)))
    )
      throw new Error('Invalid post location or expiry');
    if (
      value.eventType === 'PostCommentCreated' &&
      (typeof target.content !== 'string' ||
        !target.content ||
        target.content.length > 2000 ||
        target.status !== 'ACTIVE' ||
        target.updatedAt !== null)
    )
      throw new Error('Invalid comment content or state');
    if (value.eventType === 'PostParticipantJoined' && target.leftAt !== null)
      throw new Error('Invalid participation state');
    if (['PostDeleted', 'PostCommentDeleted'].includes(value.eventType)) {
      const actor = value.actor;
      if (
        !object(actor) ||
        !(
          (actor.type === 'USER' &&
            user(actor.userId) &&
            value.reason === 'USER_REQUEST') ||
          (actor.type === 'MODERATION' &&
            actor.userId === null &&
            value.reason === 'MODERATION_VIOLATION' &&
            typeof value.moderationDecisionId === 'string' &&
            value.moderationDecisionId.trim().length > 0)
        )
      )
        throw new Error('Invalid deletion reason');
    }
    if (
      ['PostDeleted', 'PostExpired'].includes(value.eventType) &&
      !user(value.postVersion)
    )
      throw new Error('Missing post version');
    if (
      [
        'PostReactionRemoved',
        'PostCommentDeleted',
        'PostParticipantLeft',
      ].includes(value.eventType) &&
      (!user(value.activityVersion) || !user(value.postAuthorId))
    )
      throw new Error('Missing activity context');
    return data;
  } catch (error) {
    throw new InvalidOutboxEvent(
      error instanceof Error ? error.message : 'Invalid outbox event',
    );
  }
}
