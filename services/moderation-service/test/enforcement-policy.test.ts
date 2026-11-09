import { ConfigService } from '@nestjs/config';
import { describe, expect, it } from 'vitest';
import { ContentEnforcementService } from '../src/content-moderation/content-enforcement.service.js';
import {
  contentDecision,
  parseEnforcementPolicy,
  policyFingerprint,
} from '../src/content-moderation/enforcement-policy.js';

const policy = {
  policyVersion: 'test-only-v1',
  approvedBy: 'test-reviewer',
  approvedAt: '2026-01-01T00:00:00.000Z',
  rules: [{ ruleId: 'test-threat', category: 'harassment/threatening' }],
};
const result = {
  eventId: 'evt_test',
  postId: 'post_test',
  commentId: 'comment_test',
  activityVersion: 2,
  moderatedAt: '2026-01-02T00:00:00.000Z',
  model: 'test-model',
  flagged: true,
  categories: { violence: true, 'harassment/threatening': false },
  categoryScores: { violence: 0.99, 'harassment/threatening': 0.01 },
};

describe('explicit content enforcement policy', () => {
  it('keeps enforcement OFF without policy, Redis or effect', async () => {
    const service = new ContentEnforcementService(new ConfigService());
    await expect(
      service.observeComment('post', 'comment', 1),
    ).resolves.toBeUndefined();
    await expect(service.observePostTerminal('post')).resolves.toBeUndefined();
    await expect(service.decide(result)).resolves.toBeUndefined();
    await expect(service.isReady()).resolves.toBe(true);
    await service.onModuleDestroy();
  });
  it.each([
    undefined,
    '',
    '{bad',
    {},
    { ...policy, rules: [] },
    { ...policy, rules: [{ ruleId: 'x', category: 'profanity' }] },
    {
      ...policy,
      rules: [{ ruleId: 'x', category: 'violence', minScore: 0.5 }],
    },
    { ...policy, autoDelete: true },
    { ...policy, approvedAt: 'invalid' },
  ])('rejects missing or unsupported approved policy (%j)', (raw) => {
    expect(() => parseEnforcementPolicy(raw)).toThrow('Explicit approved');
  });
  it('fails startup if enabled without approved policy', () => {
    expect(
      () =>
        new ContentEnforcementService(
          new ConfigService({ contentEnforcement: { enabled: 'true' } }),
        ),
    ).toThrow('Explicit approved');
  });
  it.each([
    'post:events',
    'moderation:events',
    'moderation:content-events',
    'moderation:report-events',
  ])('rejects collision with %s', (contentDecisionStream) => {
    expect(
      () =>
        new ContentEnforcementService(
          new ConfigService({
            redis: { url: 'redis://localhost:1', contentDecisionStream },
            contentEnforcement: { enabled: 'true', policy },
          }),
        ),
    ).toThrow('separate stream');
  });
  it('does not equate global flagged or a high unapproved score with a hide decision', () => {
    expect(contentDecision(result, policy)).toMatchObject({
      action: 'NO_ACTION',
      matchedRuleIds: [],
    });
    expect(
      contentDecision(
        {
          ...result,
          flagged: false,
          categories: { 'harassment/threatening': true },
        },
        policy,
      ),
    ).toMatchObject({
      action: 'HIDE_COMMENT',
      activityVersion: 2,
      matchedRuleIds: ['test-threat'],
    });
  });
  it('uses stable IDs, explicit original version and no private source content', () => {
    const first = contentDecision(result, policy);
    expect(contentDecision({ ...result }, policy)).toEqual(first);
    expect(
      contentDecision(result, { ...policy, policyVersion: 'test-v2' }).eventId,
    ).not.toBe(first.eventId);
    expect(() =>
      contentDecision(
        { ...result, activityVersion: undefined } as never,
        policy,
      ),
    ).toThrow('original activityVersion');
    expect(() =>
      contentDecision({ ...result, categories: { violence: true } }, policy),
    ).toThrow('category missing');
    expect(first).not.toHaveProperty('content');
    expect(first).not.toHaveProperty('approvedBy');
    expect(
      policyFingerprint(parseEnforcementPolicy(JSON.stringify(policy))),
    ).toBe(policyFingerprint(policy));
  });
});
