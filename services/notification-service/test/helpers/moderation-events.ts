import { randomUUID } from 'node:crypto';

export async function moderationEvaluation(
  targetType: 'POST' | 'COMMENT',
  flagged = false,
): Promise<Record<string, string>> {
  const source = new URL(
    '../../../moderation-service/src/content-moderation/content-event.ts',
    import.meta.url,
  );
  const { contentEvent } = await import(/* @vite-ignore */ source.href);
  const result = {
    eventId: `evt_${randomUUID()}`,
    postId: 'post_evaluation',
    moderatedAt: '2026-11-09T00:00:00.000Z',
    flagged,
    categories: { violence: flagged },
    categoryScores: { violence: flagged ? 0.9 : 0.01 },
    model: 'fixture',
  };
  const event = contentEvent(
    targetType === 'POST'
      ? { ...result, targetType, postVersion: 2 }
      : { ...result, commentId: 'comment_evaluation' },
  );
  return {
    eventId: event.eventId,
    eventType: event.eventType,
    data: JSON.stringify(event),
  };
}
