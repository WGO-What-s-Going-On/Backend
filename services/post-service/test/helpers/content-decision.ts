import { createHash, randomUUID } from 'node:crypto';
const hash = (v: string) => createHash('sha256').update(v).digest('hex');
export function decisionFields(
  postId: string,
  target:
    | { targetType: 'POST'; postVersion: number }
    | { targetType: 'COMMENT'; commentId: string; activityVersion: number } = {
    targetType: 'POST',
    postVersion: 1,
  },
) {
  const sourceEventId = `evt_${randomUUID()}`;
  const evaluationEventId = `evt_content_${hash(sourceEventId)}`;
  const policyVersion = 'openai-flagged-hide-v1';
  const identity = hash(JSON.stringify([evaluationEventId, policyVersion]));
  const value = {
    eventId: `evt_decision_${identity}`,
    moderationDecisionId: `decision_${identity}`,
    eventType: 'CONTENT_MODERATION_DECIDED',
    schemaVersion: 1,
    producer: 'moderation-service',
    sourceEventId,
    evaluationEventId,
    postId,
    ...target,
    policyVersion,
    policyFingerprint: hash(
      JSON.stringify({
        policyVersion,
        condition: 'flagged=true',
        decision: 'HIDE',
        reason: 'OPENAI_MODERATION_FLAGGED',
      }),
    ),
    decision: 'HIDE',
    reason: 'OPENAI_MODERATION_FLAGGED',
    occurredAt: new Date().toISOString(),
    correlationId: 'test-content-decision',
  };
  return {
    eventId: value.eventId,
    eventType: value.eventType,
    data: JSON.stringify(value),
  };
}
