import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/rewards/activity.service.js';
import { RewardEngine } from '../src/rewards/reward-engine.js';
import { DISABLED_POLICY } from '../src/rewards/reward-policy.js';
import { RegionalRankingWorker } from '../src/rewards/regional-ranking.worker.js';
import { RewardMaintenanceWorker } from '../src/rewards/reward-maintenance.worker.js';
import { TitleService } from '../src/rewards/title.service.js';
import { rankingWindow, TITLE_POLICY } from '../src/rewards/title-policy.js';
import {
  deletion,
  eventId,
  NOW,
  R1,
  R2,
  voteFact,
  voteTestDatabase,
} from './vote-test-context.js';

describe('Regional candidate +1 / winner +2 policy in PostgreSQL', () => {
  let context: Awaited<ReturnType<typeof voteTestDatabase>>;
  let service: ActivityService,
    titles: TitleService,
    ranker: RegionalRankingWorker;
  const window = rankingWindow(NOW);
  beforeAll(async () => {
    context = await voteTestDatabase('regional_v2');
  }, 30000);
  afterAll(async () => {
    await context?.close();
  });
  beforeEach(async () => {
    await context.fresh();
    titles = new TitleService();
    service = new ActivityService(
      context.db,
      new RewardEngine(DISABLED_POLICY),
      titles,
    );
    ranker = new RegionalRankingWorker(context.db, titles);
  });
  async function qualify(n = 10) {
    // Actual distinct wins establish global qualification outside this scoring window.
    const rows = Array.from({ length: n * 5 }, (_, i) =>
      voteFact('VOTE_WIN', String(1 + Math.floor(i / 5)), {
        occurredAt: new Date(window.start.getTime() - 86400000).toISOString(),
        regionCode: R2,
      }),
    );
    await context.db.query(
      `INSERT INTO user_activities(activity_key,post_id,kind,actor_id,beneficiary_id,version,active,event_id,correlation_id,comment_id,result_id,occurred_at,source_time_verified,source_region_code,source_region_state,source_region_event_id)
      SELECT key,"postId",'VOTE_WIN',"actorId"::bigint,"actorId"::bigint,1,true,"eventId",'global-qualification',"commentId","resultId","occurredAt"::timestamptz,true,"regionCode",'KNOWN',"eventId"
      FROM jsonb_to_recordset($1) AS x(key text,"postId" text,"actorId" text,"eventId" text,"commentId" text,"resultId" text,"occurredAt" text,"regionCode" text)`,
      [JSON.stringify(rows)],
    );
    for (let i = 1; i <= n; i++) await service.refreshUserTitles(String(i));
  }
  async function entries(region = R1) {
    const run = await ranker.recompute(region, NOW);
    return context.db.query(
      'SELECT * FROM regional_ranking_entries WHERE run_id=$1 ORDER BY rank',
      [run],
    );
  }
  async function baseline(n = 10) {
    await qualify(n);
    const facts = Array.from({ length: n }, (_, i) =>
      voteFact('VOTE_CANDIDATE', String(i + 1)),
    );
    for (const f of facts) await service.record(f);
    return facts;
  }
  it('awards +1 for a candidate and +2 for its winner, independent of scoreAtSelection', async () => {
    await qualify();
    const c = voteFact('VOTE_CANDIDATE');
    await service.record(c);
    expect((await entries())[0].score).toBe('1');
    await service.record(
      voteFact('VOTE_WIN', '1', { postId: c.postId, commentId: c.commentId! }),
    );
    const [row] = await entries();
    expect(row.score).toBe('3');
    expect(
      row.evidence.map((e: { points: number }) => e.points).sort(),
    ).toEqual([1, 2]);
  });
  it('accepts winner-first +2 without fabricating a candidate, then recalculates delayed selection to +3', async () => {
    await qualify();
    const w = voteFact('VOTE_WIN');
    await service.record(w);
    expect((await entries())[0].score).toBe('2');
    expect(
      await context.db.query(
        "SELECT * FROM user_activities WHERE kind='VOTE_CANDIDATE'",
      ),
    ).toEqual([]);
    await service.record(
      voteFact('VOTE_CANDIDATE', '1', {
        postId: w.postId,
        commentId: w.commentId!,
      }),
    );
    expect((await entries())[0].score).toBe('3');
  });
  it('stores two original comments but caps a post/author to +1, retaining it after one candidate is deleted', async () => {
    await qualify();
    const a = voteFact('VOTE_CANDIDATE'),
      b = voteFact('VOTE_CANDIDATE', '1', { postId: a.postId });
    await service.record(a);
    await service.record(b);
    expect((await entries())[0].score).toBe('1');
    await service.record(deletion(a));
    const [row] = await entries();
    expect(row.score).toBe('1');
    expect(row.evidence).toHaveLength(1);
    expect(row.evidence[0].commentId).toBe(b.commentId);
    await service.record(deletion(b));
    expect(await entries()).toEqual([]);
    expect(
      (
        await context.db.query(
          "SELECT count(*) FROM user_activities WHERE kind='VOTE_CANDIDATE'",
        )
      )[0].count,
    ).toBe('2');
  });
  it.each(['COMMENT', 'POST'] as const)(
    'does not resurrect regional points when %s deletion precedes delayed facts',
    async (kind) => {
      await qualify();
      const c = voteFact('VOTE_CANDIDATE');
      await service.record(deletion(c, kind));
      await service.record(
        voteFact('VOTE_WIN', '1', {
          postId: c.postId,
          commentId: c.commentId!,
        }),
      );
      await service.record(c);
      expect(await entries()).toEqual([]);
    },
  );
  it('retains points on natural expiry and removes them on explicit post deletion', async () => {
    await qualify();
    const c = voteFact('VOTE_CANDIDATE');
    await service.record(c);
    const terminal = deletion(c, 'POST');
    await service.record({ ...terminal, postStatus: 'EXPIRED' });
    expect((await entries())[0].score).toBe('1');
    await service.record({ ...terminal, eventId: eventId(), version: 3 });
    expect(await entries()).toEqual([]);
  });
  it('attributes candidate and winner to their own different district snapshots', async () => {
    await qualify();
    const c = voteFact('VOTE_CANDIDATE');
    await service.record(c);
    await service.record(
      voteFact('VOTE_WIN', '1', {
        postId: c.postId,
        commentId: c.commentId!,
        regionCode: R2,
      }),
    );
    expect((await entries(R1))[0].score).toBe('1');
    expect((await entries(R2))[0].score).toBe('2');
    expect(
      (
        await titles.progress(context.db.manager, '1', NOW)
      ).regionalRanking.regions.map((r) => [
        r.regionCode,
        r.score,
        r.regionName,
      ]),
    ).toEqual([
      [R1, '1', null],
      [R2, '2', null],
    ]);
  });
  it.each(['NULL', 'MISSING'] as const)(
    'keeps %s candidate region unknown when a later winner has a district',
    async (state) => {
      await qualify();
      const c = voteFact('VOTE_CANDIDATE', '1', { regionCode: null });
      if (state === 'MISSING') delete c.regionCode;
      await service.record(c);
      await service.record(
        voteFact('VOTE_WIN', '1', { postId: c.postId, regionCode: R2 }),
      );
      expect(await entries(R1)).toEqual([]);
      expect((await entries(R2))[0].score).toBe('2');
      const progress = await titles.progress(context.db.manager, '1', NOW);
      expect(progress.regionalRanking).toMatchObject({
        ready: true,
        status: 'READY_WITH_EXCLUSIONS',
        missingRegionResults: '1',
      });
    },
  );
  it('uses selectedAt at both 30-day boundaries and advances the window after a missed midnight', async () => {
    await qualify();
    const times = [
      window.start.getTime() - 1,
      window.start.getTime(),
      window.end.getTime() - 1,
      window.end.getTime(),
    ];
    const facts = times.map((t) =>
      voteFact('VOTE_CANDIDATE', '1', {
        occurredAt: new Date(t).toISOString(),
      }),
    );
    for (const f of facts) await service.record(f);
    const [row] = await entries();
    expect(row.score).toBe('2');
    expect(
      row.evidence.map((e: { activityKey: string }) => e.activityKey).sort(),
    ).toEqual([facts[1]!.key, facts[2]!.key].sort());
    const run = await ranker.recompute(R1, new Date(NOW.getTime() + 86400000));
    expect(
      (
        await context.db.query(
          'SELECT score,evidence FROM regional_ranking_entries WHERE run_id=$1',
          [run],
        )
      )[0].evidence
        .map((e: { activityKey: string }) => e.activityKey)
        .sort(),
    ).toEqual([facts[2]!.key, facts[3]!.key].sort());
  });
  it('keeps correspondent at five wins: many candidate points cannot substitute for the fifth win', async () => {
    for (let i = 0; i < 4; i++)
      await service.record(
        voteFact('VOTE_WIN', '1', {
          occurredAt: new Date(window.start.getTime() - 1).toISOString(),
        }),
      );
    for (let i = 0; i < 9; i++)
      await service.record(voteFact('VOTE_CANDIDATE'));
    expect(
      (await titles.metrics(context.db.manager, '1')).representative_wins,
    ).toBe('4');
    expect(await entries()).toEqual([]);
    expect(
      (await titles.progress(context.db.manager, '1', NOW)).regionalRanking
        .regions[0],
    ).toMatchObject({ score: '9', eligible: false });
    await service.record(
      voteFact('VOTE_WIN', '1', {
        occurredAt: new Date(window.start.getTime() - 1).toISOString(),
      }),
    );
    expect((await entries())[0]).toMatchObject({
      score: '9',
      qualifying_wins: '5',
    });
  });
  it.each([
    [9, 0],
    [10, 1],
    [19, 1],
    [20, 2],
  ])(
    'selects floor(N/10) for %i qualified positive-score users',
    async (n, slots) => {
      await baseline(n);
      const rows = await entries();
      expect(rows).toHaveLength(n);
      expect(
        rows.filter((r: { selected: boolean }) => r.selected),
      ).toHaveLength(slots);
      const [run] = await context.db.query(
        'SELECT * FROM regional_ranking_runs WHERE id=$1',
        [rows[0].run_id],
      );
      expect(run).toMatchObject({
        policy_version: 'wgo-titles-v2',
        competitors: String(n),
        slots: String(slots),
      });
    },
  );
  it('breaks tied scores by the latest counted point time ASC, then numeric user ID ASC', async () => {
    await qualify();
    await service.record(
      voteFact('VOTE_CANDIDATE', '1', { occurredAt: '2026-11-01T01:00:00Z' }),
    );
    await service.record(
      voteFact('VOTE_CANDIDATE', '1', { occurredAt: '2026-11-01T02:00:00Z' }),
    );
    await service.record(
      voteFact('VOTE_WIN', '2', { occurredAt: '2026-11-01T03:00:00Z' }),
    );
    await service.record(
      voteFact('VOTE_WIN', '3', { occurredAt: '2026-11-01T03:00:00Z' }),
    );
    const rows = await entries();
    expect(rows.map((r: { user_id: string }) => r.user_id)).toEqual([
      '1',
      '2',
      '3',
    ]);
    expect(rows[0].last_selected_at.toISOString()).toBe(
      '2026-11-01T02:00:00.000Z',
    );
  });
  it('grants, revokes and regrants once per transition; replay and worker restart do not repeat outbox notifications', async () => {
    const facts = await baseline();
    await entries();
    const count = async () =>
      (
        await context.db.query(
          "SELECT count(*) FROM outbox_events WHERE payload->'payload'->>'badgeCode'='CLAIRVOYANT'",
        )
      )[0].count;
    expect(await count()).toBe('1');
    await service.record({ ...facts[0]!, eventId: eventId() });
    await service.record(facts[0]!);
    await Promise.all([
      ranker.run(NOW),
      new RegionalRankingWorker(context.db, titles).run(NOW),
    ]);
    expect(await count()).toBe('1');
    await service.record(voteFact('VOTE_WIN', '2'));
    await new RegionalRankingWorker(context.db, titles).run(NOW);
    expect(await count()).toBe('3');
    await service.record(voteFact('VOTE_WIN', '1'));
    await new RegionalRankingWorker(context.db, titles).run(NOW);
    expect(await count()).toBe('5');
    await new RegionalRankingWorker(context.db, titles).run(NOW);
    expect(await count()).toBe('5');
    const grants = await context.db.query(
      "SELECT payload->'payload' AS p FROM outbox_events WHERE payload->'payload'->>'badgeCode'='CLAIRVOYANT' AND event_type='USER_BADGE_GRANTED'",
    );
    expect(
      grants.map(
        (g: {
          p: { policyVersion: string; regionCode: string; score: string };
        }) => g.p,
      ),
    ).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          policyVersion: TITLE_POLICY.version,
          regionCode: R1,
          rank: '1',
          score: '3',
          rankingRunId: expect.any(String),
        }),
      ]),
    );
  });
  it('recalculates after account suspension and retains historical grants', async () => {
    await baseline();
    await entries();
    await context.db.query("UPDATE users SET status='SUSPENDED' WHERE id=1");
    await new RewardMaintenanceWorker(
      context.db,
      service,
      new RewardEngine(DISABLED_POLICY),
      titles,
    ).run();
    await ranker.run(NOW);
    expect(
      (
        await context.db.query(
          'SELECT count(*) FROM user_regional_badges WHERE revoked_at IS NULL',
        )
      )[0].count,
    ).toBe('0');
    expect(
      (
        await context.db.query(
          "SELECT count(*) FROM user_badge_history h JOIN badges b ON b.id=h.badge_id WHERE b.code='CLAIRVOYANT' AND h.action='GRANTED'",
        )
      )[0].count,
    ).toBe('1');
    expect(
      (await titles.progress(context.db.manager, '1', NOW))
        .highestAchievedStage,
    ).toBe(4);
  });
  it('keeps v1 policy/run evidence immutable while recomputing v2 at the same date and revision', async () => {
    await baseline();
    await context.db.query(
      `INSERT INTO reward_policies VALUES('wgo-titles-v1','{"version":"wgo-titles-v1","regionalScore":1}')`,
    );
    const [{ input_revision: revision }] = await context.db.query(
      'SELECT input_revision FROM regional_ranking_state',
    );
    const id = '00000000-0000-4000-8000-000000000001';
    await context.db.query(
      `INSERT INTO regional_ranking_runs(id,region_code,ranking_date,window_start,window_end,input_revision,policy_version,competitors,slots)
      VALUES($1,$2,$3,$4,$5,$6,'wgo-titles-v1',10,1)`,
      [id, R1, window.date, window.start, window.end, revision],
    );
    await context.db.query('INSERT INTO regional_ranking_heads VALUES($1,$2)', [
      R1,
      id,
    ]);
    const before = await context.db.query(
      'SELECT * FROM regional_ranking_runs WHERE id=$1',
      [id],
    );
    await entries();
    expect(
      await context.db.query(
        'SELECT * FROM regional_ranking_runs WHERE id=$1',
        [id],
      ),
    ).toEqual(before);
    expect(
      (
        await context.db.query(
          "SELECT definition FROM reward_policies WHERE version='wgo-titles-v1'",
        )
      )[0].definition,
    ).toEqual({ version: 'wgo-titles-v1', regionalScore: 1 });
    expect(
      (await context.db.query('SELECT count(*) FROM regional_ranking_runs'))[0]
        .count,
    ).toBe('2');
  });
});
