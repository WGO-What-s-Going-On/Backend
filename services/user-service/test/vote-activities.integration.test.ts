import { beforeAll, afterAll, beforeEach, describe, expect, it } from 'vitest';
import { ActivityService } from '../src/rewards/activity.service.js';
import { RewardEngine } from '../src/rewards/reward-engine.js';
import { DISABLED_POLICY } from '../src/rewards/reward-policy.js';
import { TitleService } from '../src/rewards/title.service.js';
import { StoreVoteActivitySnapshots1793650000000 } from '../src/database/migrations/1793650000000-StoreVoteActivitySnapshots.js';
import {
  deletion,
  eventId,
  R2,
  voteFact,
  voteTestDatabase,
} from './vote-test-context.js';

describe('Immutable vote facts in PostgreSQL', () => {
  let context: Awaited<ReturnType<typeof voteTestDatabase>>;
  let service: ActivityService;
  beforeAll(async () => {
    context = await voteTestDatabase('vote_facts');
  }, 30000);
  afterAll(async () => {
    await context?.close();
  });
  beforeEach(async () => {
    await context.fresh();
    service = new ActivityService(
      context.db,
      new RewardEngine(DISABLED_POLICY),
    );
  });
  it('persists both candidates for one author while duplicate event/business keys leave facts and outbox unchanged', async () => {
    const a = voteFact('VOTE_CANDIDATE');
    const b = voteFact('VOTE_CANDIDATE', '1', { postId: a.postId });
    await service.record(a);
    const [{ input_revision: revision }] = await context.db.query(
      'SELECT input_revision FROM regional_ranking_state',
    );
    await Promise.all([
      service.record(a),
      service.record({ ...a, eventId: eventId() }),
    ]);
    expect(
      (
        await context.db.query(
          'SELECT input_revision FROM regional_ranking_state',
        )
      )[0].input_revision,
    ).toBe(revision);
    await service.record(b);
    const facts = await context.db.query(
      'SELECT * FROM user_activities ORDER BY activity_key',
    );
    expect(facts).toHaveLength(2);
    expect(
      facts.every(
        (f: { score_at_selection: string; source_region_state: string }) =>
          f.score_at_selection === '999' && f.source_region_state === 'KNOWN',
      ),
    ).toBe(true);
    expect(
      (await context.db.query('SELECT count(*) FROM credit_ledger'))[0].count,
    ).toBe('0');
    expect(
      (await context.db.query('SELECT count(*) FROM outbox_events'))[0].count,
    ).toBe('0');
    expect(
      (await new TitleService().metrics(context.db.manager, '1')).participation,
    ).toBe('0');
  });
  it('quarantines author, time, region and score conflicts without keeping an inbox receipt', async () => {
    const a = voteFact('VOTE_CANDIDATE');
    await service.record(a);
    for (const change of [
      { actorId: '2', beneficiaryId: '2' },
      { regionCode: R2 },
      { occurredAt: '2026-11-01T12:00:00Z' },
      { scoreAtSelection: 1 },
    ]) {
      const conflicting = { ...a, ...change, eventId: eventId() };
      await expect(service.record(conflicting)).rejects.toThrow('Conflicting');
      expect(
        await context.db.query('SELECT 1 FROM reward_inbox WHERE event_id=$1', [
          conflicting.eventId,
        ]),
      ).toEqual([]);
    }
    expect(
      (await context.db.query('SELECT count(*) FROM user_activities'))[0].count,
    ).toBe('1');
  });
  it.each(['COMMENT', 'POST'] as const)(
    'retains raw facts after %s deletion arrives before candidate and winner',
    async (kind) => {
      const a = voteFact('VOTE_CANDIDATE');
      const win = voteFact('VOTE_WIN', '1', {
        postId: a.postId,
        commentId: a.commentId!,
      });
      await service.record(deletion(a, kind));
      await service.record(win);
      await service.record(a);
      expect(
        (
          await context.db.query(
            "SELECT count(*) FROM user_activities WHERE kind LIKE 'VOTE_%'",
          )
        )[0].count,
      ).toBe('2');
      expect(
        await context.db.query(
          "SELECT * FROM reward_title_valid_activities WHERE kind LIKE 'VOTE_%'",
        ),
      ).toEqual([]);
      expect(
        (await new TitleService().metrics(context.db.manager, '1'))
          .representative_wins,
      ).toBe('0');
    },
  );
  it('stores missing, null and known region snapshots independently of each other and the post projection', async () => {
    const candidate = voteFact('VOTE_CANDIDATE', '1', { regionCode: null });
    const win = voteFact('VOTE_WIN', '1', {
      postId: candidate.postId,
      regionCode: R2,
    });
    const legacy = voteFact('VOTE_WIN');
    delete legacy.regionCode;
    await service.record(candidate);
    await service.record(win);
    await service.record(legacy);
    expect(
      (
        await context.db.query(
          'SELECT source_region_state FROM user_activities WHERE activity_key=$1',
          [candidate.key],
        )
      )[0].source_region_state,
    ).toBe('NULL');
    expect(
      (
        await context.db.query(
          'SELECT source_region_code FROM user_activities WHERE activity_key=$1',
          [win.key],
        )
      )[0].source_region_code,
    ).toBe(R2);
    expect(
      (
        await context.db.query(
          'SELECT source_region_state FROM user_activities WHERE activity_key=$1',
          [legacy.key],
        )
      )[0].source_region_state,
    ).toBe('MISSING');
    expect(await context.db.query('SELECT * FROM reward_post_regions')).toEqual(
      [],
    );
  });
  it('preserves winner business idempotency and rejects a conflicting winner', async () => {
    const win = voteFact('VOTE_WIN');
    await service.record(win);
    await service.record({ ...win, eventId: eventId() });
    await expect(
      service.record({
        ...win,
        actorId: '2',
        beneficiaryId: '2',
        eventId: eventId(),
      }),
    ).rejects.toThrow('Conflicting');
    expect(
      (await new TitleService().metrics(context.db.manager, '1'))
        .representative_wins,
    ).toBe('1');
  });
});

it('migrates existing policy, awards, ledger and ranking evidence without inferring event regions', async () => {
  const context = await voteTestDatabase('vote_upgrade', false);
  try {
    await context.fresh();
    const a = voteFact('VOTE_WIN');
    await context.db.query(
      `INSERT INTO reward_policies VALUES('wgo-titles-v1','{"legacy":true}')`,
    );
    await context.db.query(
      `INSERT INTO user_activities(activity_key,post_id,kind,actor_id,beneficiary_id,version,active,event_id,correlation_id,comment_id,result_id)
      VALUES($1,$2,'VOTE_WIN',1,1,1,true,$3,'legacy',$4,$2)`,
      [a.key, a.postId, a.eventId, a.commentId],
    );
    await context.db.query(
      `INSERT INTO reward_post_regions(post_id,version,region_code,region_name,event_id) VALUES($1,1,'1159053000','Legacy district',$2)`,
      [a.postId, a.eventId],
    );
    await context.db.query(
      `INSERT INTO credit_ledger(user_id,activity_key,event_id,policy_version,credits,growth) VALUES(1,$1,$2,'wgo-titles-v1',5,5)`,
      [a.key, a.eventId],
    );
    await context.db.query(
      `INSERT INTO user_badges(user_id,badge_id,granted_at) SELECT 1,id,now() FROM badges WHERE code='CORRESPONDENT'`,
    );
    await context.db.query(
      `INSERT INTO user_badge_history(user_id,badge_id,action,policy_version) SELECT 1,id,'GRANTED','wgo-titles-v1' FROM badges WHERE code='CORRESPONDENT'`,
    );
    await context.db
      .query(`INSERT INTO regional_ranking_runs(id,region_code,ranking_date,window_start,window_end,input_revision,policy_version,competitors,slots)
      VALUES('00000000-0000-4000-8000-000000000001','1159053000','2026-11-02',now()-interval '30 days',now(),0,'wgo-titles-v1',10,1)`);
    const tables = [
      'reward_policies',
      'user_badges',
      'user_badge_history',
      'credit_ledger',
      'regional_ranking_runs',
      'reward_post_regions',
    ];
    const before = await Promise.all(
      tables.map((t) => context.db.query(`SELECT * FROM ${t}`)),
    );
    const runner = context.db.createQueryRunner();
    await runner.connect();
    try {
      await new StoreVoteActivitySnapshots1793650000000().up(runner);
    } finally {
      await runner.release();
    }
    expect(
      await Promise.all(
        tables.map((t) => context.db.query(`SELECT * FROM ${t}`)),
      ),
    ).toEqual(before);
    expect(
      (
        await context.db.query(
          'SELECT source_region_state,source_region_code FROM user_activities',
        )
      )[0],
    ).toEqual({ source_region_state: 'LEGACY', source_region_code: null });
    const service = new ActivityService(
      context.db,
      new RewardEngine(DISABLED_POLICY),
      new TitleService({
        enabled: false,
        regionalRankingEnabled: false,
        regionContract: 'none',
      }),
    );
    await service.record({ ...a, eventId: eventId() });
    expect(
      (
        await context.db.query(
          'SELECT source_time_verified,source_region_state FROM user_activities',
        )
      )[0],
    ).toEqual({ source_time_verified: true, source_region_state: 'KNOWN' });
    expect(await context.db.query('SELECT * FROM credit_ledger')).toEqual(
      before[3],
    );
  } finally {
    await context.close();
  }
}, 30000);
