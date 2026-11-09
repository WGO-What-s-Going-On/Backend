import { createHash } from 'node:crypto';
import { contentEvent } from './content-event.js';
import type { StoredModerationResult } from './moderation-result.js';

export interface EnforcementPolicy {
  policyVersion: string;
  approvedBy: string;
  approvedAt: string;
  rules: { ruleId: string; category: string }[];
}

const categories = new Set([
  'harassment',
  'harassment/threatening',
  'hate',
  'hate/threatening',
  'illicit',
  'illicit/violent',
  'self-harm',
  'self-harm/intent',
  'self-harm/instructions',
  'sexual',
  'sexual/minors',
  'violence',
  'violence/graphic',
]);
function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[A-Za-z0-9_.:-]{1,128}$/.test(value);
}
function onlyKeys(value: Record<string, unknown>, allowed: string[]) {
  return Object.keys(value).every((key) => allowed.includes(key));
}

export function parseEnforcementPolicy(raw: unknown): EnforcementPolicy {
  const invalid = () =>
    new Error('Explicit approved content enforcement policy required');
  let value: unknown;
  try {
    value = typeof raw === 'string' ? JSON.parse(raw) : raw;
  } catch {
    throw invalid();
  }
  if (
    !record(value) ||
    !onlyKeys(value, ['policyVersion', 'approvedBy', 'approvedAt', 'rules']) ||
    !identifier(value.policyVersion) ||
    !identifier(value.approvedBy) ||
    typeof value.approvedAt !== 'string' ||
    !/^\d{4}-\d{2}-\d{2}T.*Z$/.test(value.approvedAt) ||
    !Number.isFinite(Date.parse(value.approvedAt)) ||
    !Array.isArray(value.rules) ||
    !value.rules.length ||
    value.rules.length > 50 ||
    !value.rules.every(
      (r) =>
        record(r) &&
        onlyKeys(r, ['ruleId', 'category']) &&
        identifier(r.ruleId) &&
        typeof r.category === 'string' &&
        categories.has(r.category),
    ) ||
    new Set(value.rules.map((r) => r.ruleId)).size !== value.rules.length
  )
    throw invalid();
  return {
    policyVersion: value.policyVersion,
    approvedBy: value.approvedBy,
    approvedAt: value.approvedAt,
    rules: value.rules
      .map((r) => ({
        ruleId: r.ruleId as string,
        category: r.category as string,
      }))
      .sort((a, b) => (a.ruleId < b.ruleId ? -1 : a.ruleId > b.ruleId ? 1 : 0)),
  };
}

export function policyFingerprint(policy: EnforcementPolicy): string {
  return createHash('sha256').update(JSON.stringify(policy)).digest('hex');
}

export function contentDecision(
  result: StoredModerationResult,
  policy: EnforcementPolicy,
) {
  if (
    !Number.isSafeInteger(result.activityVersion) ||
    result.activityVersion! < 1
  )
    throw new Error('Content decision requires the original activityVersion');
  // Unknown provider categories cannot silently turn into a clean decision.
  if (
    policy.rules.some((r) => typeof result.categories[r.category] !== 'boolean')
  )
    throw new Error('Configured policy category missing from evaluation');
  const evaluation = contentEvent(result);
  const identity = createHash('sha256')
    .update(JSON.stringify([evaluation.eventId, policy.policyVersion]))
    .digest('hex');
  const matchedRuleIds = policy.rules
    .filter((r) => result.categories[r.category])
    .map((r) => r.ruleId);
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
    targetType: 'COMMENT' as const,
    postId: result.postId,
    commentId: result.commentId,
    activityVersion: result.activityVersion!,
    action: matchedRuleIds.length
      ? ('HIDE_COMMENT' as const)
      : ('NO_ACTION' as const),
    policyVersion: policy.policyVersion,
    policyFingerprint: policyFingerprint(policy),
    matchedRuleIds,
    evaluatedAt: result.moderatedAt,
  };
}

export type ContentDecision = ReturnType<typeof contentDecision>;
