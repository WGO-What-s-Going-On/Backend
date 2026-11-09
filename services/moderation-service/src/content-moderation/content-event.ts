import { createHash } from 'node:crypto';
import type { StoredModerationResult } from './moderation-result.js';

export function contentEvent(result: StoredModerationResult) {
  return {
    eventId: `evt_content_${createHash('sha256').update(result.eventId).digest('hex')}`,
    eventType: 'CONTENT_MODERATION_EVALUATED' as const,
    schemaVersion: 1 as const,
    producer: 'moderation-service' as const,
    correlationId: result.correlationId ?? result.eventId,
    occurredAt: result.moderatedAt,
    sourceEventId: result.eventId,
    postId: result.postId,
    ...(result.targetType === 'POST'
      ? { targetType: 'POST' as const, postVersion: result.postVersion }
      : {
          targetType: 'COMMENT' as const,
          commentId: result.commentId,
          ...(result.activityVersion !== undefined
            ? { activityVersion: result.activityVersion }
            : {}),
        }),
    flagged: result.flagged,
    categories: result.categories,
    categoryScores: result.categoryScores,
    model: result.model,
    evaluatedAt: result.moderatedAt,
    ...(result.authorId !== undefined ? { authorId: result.authorId } : {}),
  };
}
export type ContentModerationEvent = ReturnType<typeof contentEvent>;
