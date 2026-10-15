import { randomUUID } from 'node:crypto';
import {
  parsePostEvent,
  type SupportedPostEventType,
} from '../../src/event-consumer/post-event.js';

export function wire(
  type: SupportedPostEventType,
  options: {
    postId?: string;
    eventId?: string;
    author?: number;
    actor?: number;
    version?: number;
    postVersion?: number;
    commentId?: string;
    reactionType?: string;
    legacy?: boolean;
    moderation?: boolean;
  } = {},
) {
  const postId = options.postId ?? `post_${randomUUID()}`;
  const at = new Date().toISOString();
  const author = options.author ?? 1;
  const actor = options.actor ?? 2;
  const envelope: Record<string, unknown> = {
    eventId: options.eventId ?? `evt_${randomUUID()}`,
    eventType: type,
    schemaVersion: 1,
    producer: 'post-service',
    aggregateId: postId,
    correlationId: `req_${randomUUID()}`,
    occurredAt: at,
  };
  if (['PostCreated', 'PostDeleted', 'PostExpired'].includes(type)) {
    envelope.post =
      type === 'PostCreated'
        ? {
            postId,
            authorId: author,
            latitude: 37.5,
            longitude: 127,
            radiusM: 150,
            category: 'INCIDENT',
            expiresAt: null,
          }
        : type === 'PostDeleted'
          ? { postId, authorId: author, category: 'INCIDENT', deletedAt: at }
          : {
              postId,
              authorId: author,
              category: 'INCIDENT',
              expiresAt: at,
              expiredAt: at,
            };
    if (!options.legacy)
      envelope.postVersion =
        options.postVersion ?? (type === 'PostCreated' ? 1 : 2);
  } else {
    if (!options.legacy) {
      envelope.postAuthorId = author;
      envelope.postCategory = 'INCIDENT';
      envelope.activityVersion =
        options.version ??
        ([
          'PostReactionRemoved',
          'PostCommentDeleted',
          'PostParticipantLeft',
        ].includes(type)
          ? 2
          : 1);
    }
    if (type.startsWith('PostComment'))
      envelope.comment =
        type === 'PostCommentCreated'
          ? {
              commentId: options.commentId ?? `comment_${randomUUID()}`,
              postId,
              authorId: actor,
              content: '현장 상황을 공유합니다.',
              status: 'ACTIVE',
              createdAt: at,
              updatedAt: null,
            }
          : {
              commentId: options.commentId ?? `comment_${randomUUID()}`,
              postId,
              authorId: actor,
              deletedAt: at,
            };
    if (type.startsWith('PostReaction'))
      envelope.reaction = {
        postId,
        userId: actor,
        type: options.reactionType ?? 'CURIOUS',
        createdAt: at,
        ...(type === 'PostReactionRemoved' ? { removedAt: at } : {}),
      };
    if (type.startsWith('PostParticipant'))
      envelope.participant = {
        postId,
        userId: actor,
        joinedAt: at,
        ...(type === 'PostParticipantJoined'
          ? { lastSeenAt: at, leftAt: null }
          : { leftAt: at }),
      };
  }
  if (['PostDeleted', 'PostCommentDeleted'].includes(type)) {
    envelope.actor = options.moderation
      ? { type: 'MODERATION', userId: null }
      : { type: 'USER', userId: type === 'PostDeleted' ? author : actor };
    envelope.reason = options.moderation
      ? 'MODERATION_VIOLATION'
      : 'USER_REQUEST';
    if (options.moderation) envelope.moderationDecisionId = 'decision_1';
  }
  return {
    eventId: envelope.eventId as string,
    eventType: type,
    data: JSON.stringify(envelope),
  };
}
export const event = (
  type: SupportedPostEventType,
  options?: Parameters<typeof wire>[1],
) => parsePostEvent(wire(type, options).data)!;
