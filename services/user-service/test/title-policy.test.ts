import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  loadTitleSettings,
  rankingWindow,
  TITLE_CODES,
} from '../src/rewards/title-policy.js';
import {
  DISABLED_POLICY,
  validatePolicy,
} from '../src/rewards/reward-policy.js';
import {
  parsePostEvent,
  UnsupportedRewardEvent,
} from '../src/rewards/post-event.js';
describe('Confirmed title settings and proposed region boundary', () => {
  it('separates title, credit and regional switches with title defaults ON', () => {
    expect(
      loadTitleSettings({ USER_REGIONAL_RANKING_ENABLED: 'false' }),
    ).toEqual({
      enabled: true,
      regionalRankingEnabled: false,
      regionContract: 'none',
    });
    expect(
      loadTitleSettings({
        USER_TITLES_ENABLED: 'false',
        USER_TITLE_REGION_CONTRACT: 'post-region-v1',
      }).enabled,
    ).toBe(false);
    expect(DISABLED_POLICY.enabled).toBe(false);
    for (const env of [
      { USER_TITLES_ENABLED: 'yes' },
      { USER_REGIONAL_RANKING_ENABLED: '1' },
      { USER_TITLE_REGION_CONTRACT: 'map-guess' },
    ])
      expect(() => loadTitleSettings(env)).toThrow();
  });
  it.each(TITLE_CODES)(
    'prevents a credit-score rule from granting the confirmed %s title',
    (code) => {
      expect(() =>
        validatePolicy({
          ...DISABLED_POLICY,
          enabled: true,
          badges: [{ code, minimumScore: 0, revokeBelow: true, rankTop: 1 }],
        }),
      ).toThrow();
    },
  );
  it('uses midnight Asia/Seoul and an exact 30-day half-open window regardless of host zone', () => {
    const before = rankingWindow(new Date('2026-10-30T14:59:59.999Z')),
      after = rankingWindow(new Date('2026-10-30T15:00:00.000Z'));
    expect(before.date).toBe('2026-10-30');
    expect(after.date).toBe('2026-10-31');
    expect(after.end.toISOString()).toBe('2026-10-30T15:00:00.000Z');
    expect(after.end.getTime() - after.start.getTime()).toBe(30 * 86400000);
    expect(before.next).toEqual(after.end);
  });
  function fields(
    region: unknown = {
      code: '1159063000',
      name: '상도1동',
      type: 'H',
      version: 1,
    },
    version = 1,
  ) {
    const eventId = `evt_${randomUUID()}`,
      eventType = 'PostRegionResolved';
    return {
      eventId,
      eventType,
      data: JSON.stringify({
        eventId,
        eventType,
        schemaVersion: 1,
        producer: 'post-service',
        aggregateId: `post_${randomUUID()}`,
        correlationId: 'region-contract-test',
        occurredAt: new Date().toISOString(),
        postAuthorId: 1,
        postRegion: region,
        regionVersion: version,
      }),
    };
  }
  it('does not pretend the proposed producer exists before contract activation', () => {
    expect(() => parsePostEvent(fields())).toThrow(UnsupportedRewardEvent);
    expect(
      parsePostEvent(fields(), 'post-region-v1')!.regionUpdate?.region?.code,
    ).toBe('1159063000');
    expect(
      parsePostEvent(fields(null, 2), 'post-region-v1')!.regionUpdate,
    ).toEqual({ version: 2, region: null });
  });
  it.each([
    { code: '11590', name: 'Wrong', type: 'H', version: 1 },
    { code: '1159063000', name: 'Legal district', type: 'B', version: 1 },
    { code: '1159063000', name: '', type: 'H', version: 1 },
    { code: '1159063000', name: 'District', type: 'H', version: 0 },
    { code: '1159063000', name: 'District', type: 'H', version: 2 },
  ])(
    'rejects invalid or conflicting administrative region snapshots %j',
    (region) => {
      expect(() => parsePostEvent(fields(region), 'post-region-v1')).toThrow();
    },
  );
});
