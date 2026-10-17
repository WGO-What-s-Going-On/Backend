export class InvalidRewardEvent extends Error {}
export interface ActivityInput {
  eventId: string;
  correlationId: string;
  postId: string;
  key: string;
  kind:
    | 'POST'
    | 'COMMENT'
    | 'PARTICIPATION'
    | 'POST_REACTION'
    | 'COMMENT_REACTION'
    | 'VOTE_WIN';
  actorId: string;
  beneficiaryId: string | null;
  reactionType: string | null;
  version: number;
  active: boolean;
  postStatus?: 'ACTIVE' | 'DELETED' | 'EXPIRED';
}
const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const id = (v: unknown, p: string) =>
  typeof v === 'string' && new RegExp(`^${p}_${uuid}$`).test(v);
const positive = (v: unknown): v is number =>
  Number.isSafeInteger(v) && Number(v) > 0;
const record = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);
const date = (v: unknown) =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));
function check(v: unknown): asserts v {
  if (!v) throw new InvalidRewardEvent('Invalid Post reward event');
}

// Retain identifiers and state only: content, location and profile data stay with Post.
export function parsePostEvent(fields: Record<string, string>): ActivityInput {
  let v: unknown;
  try {
    v = JSON.parse(fields.data!);
  } catch {
    throw new InvalidRewardEvent('Invalid Post JSON');
  }
  check(record(v));
  check(
    id(v.eventId, 'evt') &&
      id(v.aggregateId, 'post') &&
      v.schemaVersion === 1 &&
      v.producer === 'post-service' &&
      typeof v.correlationId === 'string' &&
      v.correlationId.trim() &&
      date(v.occurredAt) &&
      fields.eventId === v.eventId &&
      fields.eventType === v.eventType,
  );
  const types: Record<string, [ActivityInput['kind'], string, boolean]> = {
    PostCreated: ['POST', 'post', true],
    PostDeleted: ['POST', 'post', false],
    PostExpired: ['POST', 'post', false],
    PostCommentCreated: ['COMMENT', 'comment', true],
    PostCommentDeleted: ['COMMENT', 'comment', false],
    PostReactionCreated: ['POST_REACTION', 'reaction', true],
    PostReactionRemoved: ['POST_REACTION', 'reaction', false],
    PostParticipantJoined: ['PARTICIPATION', 'participant', true],
    PostParticipantLeft: ['PARTICIPATION', 'participant', false],
  };
  check(typeof v.eventType === 'string' && Object.hasOwn(types, v.eventType));
  const [kind, field, active] = types[v.eventType]!;
  const target = v[field];
  check(record(target) && target.postId === v.aggregateId);
  const actor = target.authorId ?? target.userId;
  check(positive(actor));
  if (v.postAuthorId !== undefined) check(positive(v.postAuthorId));
  for (const k of ['activityVersion', 'postVersion'])
    if (v[k] !== undefined) check(positive(v[k]));
  const version =
    kind === 'POST' ? (v.postVersion ?? 1) : (v.activityVersion ?? 1);
  check(positive(version));
  if (!active)
    check(positive(kind === 'POST' ? v.postVersion : v.activityVersion));
  if (!active && kind !== 'POST')
    check(
      positive(v.postAuthorId) &&
        typeof v.postCategory === 'string' &&
        /^[A-Z][A-Z_]{0,39}$/.test(v.postCategory),
    );
  if (kind === 'POST')
    check(
      typeof target.category === 'string' &&
        /^[A-Z][A-Z_]{0,39}$/.test(target.category),
    );
  if (v.eventType === 'PostCreated')
    check(
      typeof target.latitude === 'number' &&
        Number.isFinite(target.latitude) &&
        Math.abs(target.latitude) <= 90 &&
        typeof target.longitude === 'number' &&
        Number.isFinite(target.longitude) &&
        Math.abs(target.longitude) <= 180 &&
        typeof target.radiusM === 'number' &&
        Number.isFinite(target.radiusM) &&
        target.radiusM >= 1 &&
        target.radiusM <= 10000 &&
        (target.expiresAt === null || date(target.expiresAt)),
    );
  if (v.eventType === 'PostCommentCreated')
    check(
      typeof target.content === 'string' &&
        target.content.length > 0 &&
        target.content.length <= 2000 &&
        target.status === 'ACTIVE' &&
        target.updatedAt === null,
    );
  if (kind === 'COMMENT')
    check(
      id(target.commentId, 'comment') &&
        date(active ? target.createdAt : target.deletedAt),
    );
  if (kind === 'POST_REACTION')
    check(
      ['LIKE', 'CURIOUS', 'STILL_HAPPENING', 'HELPFUL', 'ENDED'].includes(
        String(target.type),
      ) &&
        date(target.createdAt) &&
        (active || date(target.removedAt)),
    );
  if (kind === 'PARTICIPATION')
    check(
      date(target.joinedAt) &&
        (active
          ? target.leftAt === null && date(target.lastSeenAt)
          : date(target.leftAt)),
    );
  if (kind === 'POST' && !active)
    check(
      date(v.eventType === 'PostDeleted' ? target.deletedAt : target.expiredAt),
    );
  if (v.eventType === 'PostExpired') check(date(target.expiresAt));
  if (v.eventType === 'PostDeleted' || v.eventType === 'PostCommentDeleted') {
    check(
      record(v.actor) &&
        ((v.actor.type === 'USER' &&
          positive(v.actor.userId) &&
          v.reason === 'USER_REQUEST') ||
          (v.actor.type === 'MODERATION' &&
            v.actor.userId === null &&
            v.reason === 'MODERATION_VIOLATION' &&
            typeof v.moderationDecisionId === 'string' &&
            v.moderationDecisionId.trim())),
    );
  }
  const postId = v.aggregateId as string;
  return {
    eventId: v.eventId as string,
    correlationId: v.correlationId as string,
    postId,
    key:
      kind === 'POST'
        ? postId
        : kind === 'COMMENT'
          ? String(target.commentId)
          : `${postId}:${kind}:${actor}:${kind === 'POST_REACTION' ? target.type : ''}`,
    kind,
    actorId: String(actor),
    beneficiaryId:
      kind === 'POST'
        ? String(actor)
        : v.postAuthorId === undefined
          ? null
          : String(v.postAuthorId),
    reactionType: kind === 'POST_REACTION' ? String(target.type) : null,
    version,
    active,
    ...(kind === 'POST'
      ? {
          postStatus:
            v.eventType === 'PostDeleted'
              ? ('DELETED' as const)
              : v.eventType === 'PostExpired'
                ? ('EXPIRED' as const)
                : ('ACTIVE' as const),
        }
      : {}),
  };
}

// Proposed inputs only. The live consumer intentionally accepts only the nine published types.
export function parseFutureRewardInput(value: unknown): ActivityInput {
  check(record(value));
  check(
    ['COMMENT_REACTION', 'VOTE_WIN'].includes(String(value.kind)) &&
      id(value.eventId, 'evt') &&
      id(value.postId, 'post') &&
      typeof value.correlationId === 'string' &&
      value.correlationId.trim() &&
      positive(value.version) &&
      positive(value.actorId) &&
      positive(value.beneficiaryId) &&
      typeof value.active === 'boolean' &&
      id(value.commentId, 'comment'),
  );
  const kind = value.kind as 'COMMENT_REACTION' | 'VOTE_WIN';
  if (kind === 'COMMENT_REACTION')
    check(
      ['HELPFUL', 'AGREE', 'DIFFERENT'].includes(String(value.reactionType)),
    );
  else
    check(
      typeof value.resultId === 'string' &&
        value.resultId.trim() &&
        value.active === true,
    );
  return {
    eventId: String(value.eventId),
    correlationId: String(value.correlationId),
    postId: String(value.postId),
    key:
      kind === 'VOTE_WIN'
        ? `vote:${value.resultId}:${value.beneficiaryId}`
        : `${value.commentId}:reaction:${value.actorId}:${value.reactionType}`,
    kind,
    actorId: String(value.actorId),
    beneficiaryId: String(value.beneficiaryId),
    reactionType: kind === 'VOTE_WIN' ? null : String(value.reactionType),
    version: value.version as number,
    active: value.active as boolean,
  };
}
