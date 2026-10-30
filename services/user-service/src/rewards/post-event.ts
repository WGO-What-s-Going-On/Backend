export class InvalidRewardEvent extends Error {}
export class ConflictingRewardEvent extends InvalidRewardEvent {}
export class UnsupportedRewardEvent extends InvalidRewardEvent {}
export interface PostRegionSnapshot {
  code: string;
  name: string;
  type: 'H';
  version: number;
}
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
  commentId?: string;
  resultId?: string;
  occurredAt?: string;
  postRegion?: PostRegionSnapshot;
  regionUpdate?: { version: number; region: PostRegionSnapshot | null };
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
export function parsePostEvent(
  fields: Record<string, string>,
  regionContract: 'none' | 'post-region-v1' = 'none',
): ActivityInput | null {
  let v: unknown;
  try {
    v = JSON.parse(fields.data!);
  } catch {
    throw new InvalidRewardEvent('Invalid Post JSON');
  }
  check(record(v));
  check(
    typeof v.eventType === 'string' &&
      v.eventType.length > 0 &&
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
  if (
    v.eventType === 'PostRegionResolved' &&
    regionContract === 'post-region-v1'
  ) {
    check(positive(v.postAuthorId) && positive(v.regionVersion));
    const region =
      v.postRegion === null ? null : parseRegionSnapshot(v.postRegion);
    check(region === null || region.version === v.regionVersion);
    return {
      eventId: String(v.eventId),
      correlationId: String(v.correlationId),
      postId: String(v.aggregateId),
      key: String(v.aggregateId),
      kind: 'POST',
      actorId: String(v.postAuthorId),
      beneficiaryId: null,
      reactionType: null,
      version: v.regionVersion as number,
      active: false,
      regionUpdate: { version: v.regionVersion as number, region },
    };
  }
  if (v.eventType === 'PostUpdated') {
    check(
      record(v.post) &&
        v.post.postId === v.aggregateId &&
        positive(v.post.authorId) &&
        typeof v.post.category === 'string' &&
        positive(v.postVersion) &&
        (v.post.closedAt === null || date(v.post.closedAt)),
    );
    // Closing/reopening an existing post does not create a new reward or delete it.
    return null;
  }
  if (
    v.eventType === 'PostCommentReactionCreated' ||
    v.eventType === 'PostCommentReactionRemoved'
  ) {
    const r = v.commentReaction;
    const active = v.eventType === 'PostCommentReactionCreated';
    check(
      record(r) &&
        r.postId === v.aggregateId &&
        id(r.commentId, 'comment') &&
        positive(r.userId) &&
        positive(v.commentAuthorId) &&
        positive(v.activityVersion) &&
        ['HELPFUL', 'AGREE', 'DIFFERENT'].includes(String(r.type)) &&
        date(r.createdAt) &&
        (active || date(r.removedAt)),
    );
    return {
      eventId: String(v.eventId),
      correlationId: String(v.correlationId),
      postId: String(v.aggregateId),
      key: `${r.commentId}:reaction:${r.userId}:${r.type}`,
      kind: 'COMMENT_REACTION',
      commentId: String(r.commentId),
      actorId: String(r.userId),
      beneficiaryId: String(v.commentAuthorId),
      reactionType: String(r.type),
      version: v.activityVersion as number,
      active,
      occurredAt: String(v.occurredAt),
    };
  }
  if (v.eventType === 'PostVoteWon') {
    const vote = v.vote;
    check(
      record(vote) &&
        vote.postId === v.aggregateId &&
        vote.resultId === v.aggregateId &&
        id(vote.commentId, 'comment') &&
        positive(vote.winnerAuthorId) &&
        positive(vote.votes) &&
        date(vote.closedAt) &&
        v.activityVersion === 1,
    );
    return {
      eventId: String(v.eventId),
      correlationId: String(v.correlationId),
      postId: String(v.aggregateId),
      key: `vote:${vote.resultId}`,
      kind: 'VOTE_WIN',
      commentId: String(vote.commentId),
      resultId: String(vote.resultId),
      actorId: String(vote.winnerAuthorId),
      beneficiaryId: String(vote.winnerAuthorId),
      reactionType: null,
      version: 1,
      active: true,
      occurredAt: String(vote.closedAt),
      ...(regionContract === 'post-region-v1' && v.postRegion !== undefined
        ? { postRegion: parseRegionSnapshot(v.postRegion) }
        : {}),
    };
  }
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
  if (typeof v.eventType !== 'string' || !Object.hasOwn(types, v.eventType))
    throw new UnsupportedRewardEvent('Unsupported Post reward event');
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
    occurredAt: String(v.occurredAt),
    ...(kind === 'COMMENT' ? { commentId: String(target.commentId) } : {}),
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

export function parseRegionSnapshot(v: unknown): PostRegionSnapshot {
  check(
    record(v) &&
      typeof v.code === 'string' &&
      /^[0-9]{10}$/.test(v.code) &&
      typeof v.name === 'string' &&
      v.name.trim().length > 0 &&
      v.name.length <= 200 &&
      v.type === 'H' &&
      positive(v.version),
  );
  return {
    code: v.code as string,
    name: v.name as string,
    type: 'H',
    version: v.version as number,
  };
}

// Internal/reconciliation fixture adapter. Live producers use parsePostEvent above.
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
        ? `vote:${value.resultId}`
        : `${value.commentId}:reaction:${value.actorId}:${value.reactionType}`,
    kind,
    actorId: String(value.actorId),
    beneficiaryId: String(value.beneficiaryId),
    reactionType: kind === 'VOTE_WIN' ? null : String(value.reactionType),
    version: value.version as number,
    active: value.active as boolean,
    commentId: String(value.commentId),
    ...(kind === 'VOTE_WIN' ? { resultId: String(value.resultId) } : {}),
  };
}
