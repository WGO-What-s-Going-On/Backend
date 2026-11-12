import { createHash } from 'node:crypto';
import { contentEvent } from './content-event.js';
import type { StoredModerationResult } from './moderation-result.js';

export interface EnforcementPolicy {
  policyVersion: string;
}

export const DEFAULT_ENFORCEMENT_POLICY_VERSION = 'openai-flagged-hide-v1';

export function parseEnforcementPolicy(version: unknown): EnforcementPolicy {
  if (typeof version !== 'string' || !/^[A-Za-z0-9_.:-]{1,128}$/.test(version))
    throw new Error('Valid content enforcement policy version required');
  return { policyVersion: version };
}

export function policyFingerprint(policy: EnforcementPolicy): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        policyVersion: policy.policyVersion,
        condition: 'flagged=true',
        decision: 'HIDE',
        reason: 'OPENAI_MODERATION_FLAGGED',
      }),
    )
    .digest('hex');
}

export function contentDecision(
  result: StoredModerationResult,
  policy: EnforcementPolicy,
) {
  // This explicitly authorized policy uses the canonical flagged verdict only.
  // Safe evaluations remain facts; they never become a HIDE or restore command.
  if (result.flagged !== true) return null;
  const version =
    result.targetType === 'POST' ? result.postVersion : result.activityVersion;
  if (!Number.isSafeInteger(version) || version! < 1)
    throw new Error('Content decision requires the original target version');
  const evaluation = contentEvent(result);
  const identity = createHash('sha256')
    .update(JSON.stringify([evaluation.eventId, policy.policyVersion]))
    .digest('hex');
  return {
    eventId: `evt_decision_${identity}`,
    moderationDecisionId: `decision_${identity}`,
    eventType: 'CONTENT_MODERATION_DECIDED' as const,
    schemaVersion: 1 as const,
    producer: 'moderation-service' as const,
    correlationId: evaluation.correlationId,
    occurredAt: result.moderatedAt,
    sourceEventId: result.eventId,
    evaluationEventId: evaluation.eventId,
    postId: result.postId,
    ...(result.targetType === 'POST'
      ? { targetType: 'POST' as const, postVersion: result.postVersion }
      : {
          targetType: 'COMMENT' as const,
          commentId: result.commentId,
          activityVersion: result.activityVersion!,
        }),
    decision: 'HIDE' as const,
    reason: 'OPENAI_MODERATION_FLAGGED' as const,
    policyVersion: policy.policyVersion,
    policyFingerprint: policyFingerprint(policy),
  };
}

export type ContentDecision = NonNullable<ReturnType<typeof contentDecision>>;
