import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import {
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DataSource } from 'typeorm';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddActivityRewards1792190000000 } from '../src/database/migrations/1792190000000-AddActivityRewards.js';
import { AddPrivateRealName1793200000000 } from '../src/database/migrations/1793200000000-AddPrivateRealName.js';
import { CompleteActivityRewards1793360000000 } from '../src/database/migrations/1793360000000-CompleteActivityRewards.js';
import { ActivateWgoTitles1793400000000 } from '../src/database/migrations/1793400000000-ActivateWgoTitles.js';
import { StoreVoteActivitySnapshots1793650000000 } from '../src/database/migrations/1793650000000-StoreVoteActivitySnapshots.js';
import { ApplyRegionalTitlePolicyV21793651000000 } from '../src/database/migrations/1793651000000-ApplyRegionalTitlePolicyV2.js';
import { AddTitlePolicyV31795300000000 } from '../src/database/migrations/1795300000000-AddTitlePolicyV3.js';
import { ActivityService } from '../src/rewards/activity.service.js';
import { RewardEngine } from '../src/rewards/reward-engine.js';
import { DISABLED_POLICY } from '../src/rewards/reward-policy.js';
import { TitleService } from '../src/rewards/title.service.js';
import { TITLE_POLICY } from '../src/rewards/title-policy.js';
import {
  TitleV3,
  TITLE_V3_POLICY,
  titleV3Enabled,
} from '../src/rewards/title-v3.js';
import { seedBadgeCatalog } from '../src/rewards/badge-catalog.js';
import {
  parsePostEvent,
  type ActivityInput,
} from '../src/rewards/post-event.js';
import { AuthService } from '../src/auth/auth.service.js';
import { RegionalRankingWorker } from '../src/rewards/regional-ranking.worker.js';

const database = `wgo_title_v3_${process.pid}_${Date.now()}`;
const options = {
  type: 'postgres' as const,
  host: '127.0.0.1',
  port: 5432,
  username: 'wgo',
  password: 'wgo',
};
const id = (prefix: string) => `${prefix}_${randomUUID()}`;
function activity(
  kind: ActivityInput['kind'],
  actorId = '1',
  postId = id('post'),
  key = id('comment'),
): ActivityInput {
  return {
    kind,
    actorId,
    postId,
    key,
    eventId: id('evt'),
    correlationId: 'title-v3-test',
    beneficiaryId: null,
    reactionType: null,
    version: 1,
    active: true,
    ...(kind === 'POST' ? { key: postId, postStatus: 'ACTIVE' as const } : {}),
    ...(kind === 'COMMENT' ? { commentId: key } : {}),
  };
}
describe('v3 titles against real PostgreSQL', () => {
  let db: DataSource,
    admin: DataSource,
    titles: TitleService,
    service: ActivityService;
  beforeAll(async () => {
    admin = new DataSource({ ...options, database: 'postgres' });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${database}"`);
    db = new DataSource({
      ...options,
      database,
      entities: [...USER_SERVICE_ENTITIES],
      migrations: [
        InitialUserServiceSchema1789990707351,
        AddActivityRewards1792190000000,
        AddPrivateRealName1793200000000,
        CompleteActivityRewards1793360000000,
        ActivateWgoTitles1793400000000,
        StoreVoteActivitySnapshots1793650000000,
        ApplyRegionalTitlePolicyV21793651000000,
        AddTitlePolicyV31795300000000,
      ],
    });
    await db.initialize();
    await db.runMigrations();
  }, 30000);
  afterAll(async () => {
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${database}" WITH(FORCE)`);
      await admin.destroy();
    }
  });
  afterEach(() => vi.unstubAllEnvs());
  beforeEach(async () => {
    vi.stubEnv('USER_TITLES_V3_ENABLED', 'true');
    await db.query(
      'TRUNCATE users,reward_policies,user_activities,reward_posts,reward_inbox,outbox_events,title_vote_selections,title_hidden_content RESTART IDENTITY CASCADE',
    );
    await db.query(
      "INSERT INTO users(id,nickname,status,created_at,updated_at) SELECT i,'Title user '||i,'ACTIVE',now(),now() FROM generate_series(1,30) i",
    );
    await db.query(
      "SELECT setval(pg_get_serial_sequence('users','id'),100,true)",
    );
    await db.transaction(seedBadgeCatalog);
    titles = new TitleService({
      enabled: true,
      regionalRankingEnabled: true,
      regionContract: 'post-region-v1',
    });
    service = new ActivityService(
      db,
      new RewardEngine(DISABLED_POLICY),
      titles,
    );
  });
  const progress = async () => (await service.summary('1')).titles;
  async function participation(n: number) {
    for (let i = 0; i < n; i++) await service.record(activity('POST'));
  }
  async function comment(postId = id('post')) {
    const a = activity('COMMENT', '1', postId);
    await service.record(a);
    return a;
  }
  async function agree(c: ActivityInput, actor = '2') {
    const a = {
      ...activity(
        'COMMENT_REACTION',
        actor,
        c.postId,
        `${c.commentId}:reaction:${actor}:AGREE`,
      ),
      commentId: c.commentId!,
      beneficiaryId: '1',
      reactionType: 'AGREE',
    };
    await service.record(a);
    return a;
  }
  async function winner() {
    const p = activity('POST', '30');
    await service.record(p);
    const c = await comment(p.postId);
    await service.record({
      ...activity('VOTE_WIN', '1', p.postId, `vote:${p.postId}`),
      beneficiaryId: '1',
      commentId: c.commentId!,
      resultId: p.postId,
    });
    return { p, c };
  }
  async function stats() {
    return (await progress()).stats;
  }
  async function selection(p: string, c: string | null, version: number) {
    const e = {
      eventId: id('evt'),
      eventType: 'PostVoteSelectionChanged',
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: p,
      correlationId: 'v3-selection',
      occurredAt: new Date().toISOString(),
      activityVersion: version,
      voteSelection: {
        postId: p,
        userId: 1,
        commentId: c,
        updatedAt: new Date().toISOString(),
      },
    };
    const a = parsePostEvent({
      eventId: e.eventId,
      eventType: e.eventType,
      data: JSON.stringify(e),
    })!;
    await service.record(a);
    return a;
  }
  it('grants the signup title in the existing user creation transaction', async () => {
    const auth = new AuthService(db, {} as never, {} as never, {} as never);
    const user = await (
      auth as unknown as { createUser(id: string): Promise<{ id: string }> }
    ).createUser('v3-new-user');
    const result = await service.summary(user.id);
    expect(result.titles.currentStage).toBe(1);
    expect(result.titles.policyVersion).toBe('wgo-titles-v3');
    expect(result.titles.stats).toEqual({
      participation: '0',
      agreeReceived: '0',
      picks: '0',
    });
    expect(await db.query('SELECT * FROM credit_ledger')).toHaveLength(0);
  });
  it('promotes participation 9 to 10, then received AGREE 9 to 10 across comments, then wins 4 to 5', async () => {
    await participation(7);
    const a = await comment(),
      b = await comment();
    expect((await progress()).currentStage).toBe(1);
    await service.record(activity('POST'));
    expect((await progress()).currentStage).toBe(2);
    for (let i = 2; i <= 10; i++) await agree(i % 2 ? a : b, String(i));
    expect((await progress()).currentStage).toBe(2);
    expect((await progress()).stages[2]).toMatchObject({
      progress: '9',
      remaining: '1',
    });
    await agree(a, '11');
    expect((await progress()).currentStage).toBe(3);
    for (let i = 0; i < 4; i++) await winner();
    expect((await progress()).stages[3]).toMatchObject({
      progress: '40',
      remaining: '10',
    });
    await winner();
    expect((await progress()).currentStage).toBe(4);
    expect(await db.query('SELECT * FROM credit_ledger')).toHaveLength(0);
  });
  it('keeps sequential promotion even with ten received AGREE and five wins', async () => {
    const c = await comment();
    for (let i = 2; i <= 11; i++) await agree(c, String(i));
    for (let i = 0; i < 5; i++) await winner();
    expect((await progress()).currentStage).toBe(1);
    expect((await progress()).stats).toMatchObject({
      participation: '6',
      agreeReceived: '10',
      picks: '5',
    });
  });
  it('retains one current selection through choose, change, cancel, reselect and stale/duplicate delivery', async () => {
    await participation(9);
    const p = id('post'),
      c = id('comment');
    const chosen = await selection(p, c, 1);
    await service.record(chosen);
    expect((await progress()).currentStage).toBe(2);
    await selection(p, id('comment'), 2);
    expect((await stats())?.participation).toBe('10');
    await selection(p, null, 3);
    expect((await progress()).currentStage).toBe(1);
    await service.record({ ...chosen, eventId: id('evt') });
    expect((await stats())?.participation).toBe('9');
    await selection(p, c, 4);
    expect((await progress()).currentStage).toBe(2);
    await expect(selection(p, null, 4)).rejects.toThrow(
      'Conflicting vote selection version',
    );
  });
  it('counts self AGREE like Post and ignores old agree after cancel/re-agree', async () => {
    await participation(9);
    const c = await comment();
    for (let i = 2; i <= 10; i++) await agree(c, String(i));
    const a = await agree(c, '1');
    expect((await progress()).currentStage).toBe(3);
    const cancel = { ...a, active: false, version: 2, eventId: id('evt') };
    await service.record(cancel);
    expect((await progress()).currentStage).toBe(2);
    await service.record({ ...a, version: 3, eventId: id('evt') });
    await service.record({ ...cancel, eventId: id('evt') });
    expect((await stats())?.agreeReceived).toBe('10');
    expect((await progress()).currentStage).toBe(3);
  });
  it('refreshes a winner after its parent creation arrives last, and applies comment deletion before creation', async () => {
    const p = activity('POST', '30'),
      c = activity('COMMENT', '1', p.postId);
    await service.record({
      ...activity('VOTE_WIN', '1', p.postId, `vote:${p.postId}`),
      beneficiaryId: '1',
      commentId: c.commentId!,
      resultId: p.postId,
    });
    await agree(c);
    expect((await stats())?.agreeReceived).toBe('0');
    await service.record(c);
    expect(await stats()).toEqual({
      participation: '1',
      agreeReceived: '1',
      picks: '0',
    });
    await service.record(p);
    expect(await stats()).toEqual({
      participation: '1',
      agreeReceived: '1',
      picks: '1',
    });
    const deleted = activity('COMMENT', '1', p.postId);
    await service.record({
      ...deleted,
      active: false,
      version: 2,
      eventId: id('evt'),
    });
    await service.record(deleted);
    expect((await stats())?.participation).toBe('1');
  });
  it('preserves existing credits/growth and never calls the reward engine for title-only inputs or reevaluation', async () => {
    await participation(1);
    await db.query(
      "INSERT INTO reward_policies(version,definition) VALUES('existing-policy','{}')",
    );
    await db.query(
      "INSERT INTO user_growth(user_id,credits,growth_score,level,policy_version) VALUES(1,123,456,2,'existing-policy')",
    );
    await db.query(
      "INSERT INTO credit_ledger(user_id,activity_key,event_id,policy_version,credits,growth) SELECT 1,activity_key,'legacy-grant','existing-policy',123,456 FROM user_activities LIMIT 1",
    );
    const before = await db.query('SELECT * FROM user_growth');
    const ledger = await db.query('SELECT * FROM credit_ledger');
    const engine = new RewardEngine({
      ...DISABLED_POLICY,
      enabled: true,
      version: 'unrelated-credit-policy',
    });
    const evaluate = vi.spyOn(engine, 'evaluate'),
      syncBadges = vi.spyOn(engine, 'syncBadges');
    const isolated = new ActivityService(db, engine, titles);
    const p = id('post');
    const vote = await selection(p, id('comment'), 1);
    await isolated.record({
      ...vote,
      version: 2,
      voteSelection: { commentId: null },
      active: false,
      eventId: id('evt'),
    });
    await isolated.record({
      ...activity('POST', '1', p),
      hiddenContent: { kind: 'POST', targetId: p },
      active: false,
      version: 3,
    });
    await db.transaction((m) =>
      titles.syncUser(m, '1', {
        eventId: 'title-only-apply',
        correlationId: 'reconcile',
        notificationMode: 'silent',
      }),
    );
    expect(evaluate).not.toHaveBeenCalled();
    expect(syncBadges).not.toHaveBeenCalled();
    expect(await db.query('SELECT * FROM user_growth')).toEqual(before);
    expect(await db.query('SELECT * FROM credit_ledger')).toEqual(ledger);
  });
  it('records silent baseline transitions once and keeps historical grants after subsequent revocation', async () => {
    await service.refreshUserTitles('1');
    let events = await db.query(
      "SELECT payload->'payload' AS payload FROM outbox_events WHERE event_type LIKE 'USER_BADGE_%'",
    );
    expect(events).toHaveLength(1);
    expect(events[0].payload.notificationMode).toBe('silent');
    const initialHistory = await db.query(
      'SELECT * FROM user_badge_history ORDER BY id',
    );
    await service.refreshUserTitles('1');
    expect(
      await db.query('SELECT * FROM user_badge_history ORDER BY id'),
    ).toEqual(initialHistory);
    await db.query("UPDATE users SET status='SUSPENDED' WHERE id=1");
    await service.refreshUserTitles('1');
    expect((await progress()).currentStage).toBe(0);
    expect((await progress()).highestAchievedStage).toBe(1);
    const history = await db.query(
      'SELECT * FROM user_badge_history ORDER BY id',
    );
    expect(history).toHaveLength(2);
    expect(history[0]).toEqual(initialHistory[0]);
    events = await db.query(
      "SELECT payload->'payload' AS payload FROM outbox_events WHERE event_type LIKE 'USER_BADGE_%'",
    );
    expect(
      events.every(
        (event: { payload: { notificationMode: string } }) =>
          event.payload.notificationMode === 'silent',
      ),
    ).toBe(true);
  });
  it.each(['DELETE', 'HIDE'] as const)(
    'matches Post child-retention rules after %s, including late events and natural expiry',
    async (action) => {
      const { p, c } = await winner();
      const a = await agree(c, '1');
      await selection(p.postId, c.commentId!, 1);
      expect(await stats()).toEqual({
        participation: '3',
        agreeReceived: '1',
        picks: '1',
      });
      // The author's parent contributes one; expiry retains it and all child relations.
      const own = activity('POST');
      await service.record(own);
      await service.record({
        ...own,
        active: false,
        postStatus: 'EXPIRED',
        version: 2,
        eventId: id('evt'),
      });
      expect((await stats())?.participation).toBe('4');
      const hidden = (a: ActivityInput, kind: 'POST' | 'COMMENT') => ({
        ...a,
        active: false,
        version: 3,
        eventId: id('evt'),
        hiddenContent: {
          kind,
          targetId: kind === 'POST' ? a.postId : a.commentId!,
        },
      });
      if (action === 'DELETE')
        await service.record({
          ...p,
          active: false,
          postStatus: 'DELETED',
          version: 2,
          eventId: id('evt'),
        });
      else await service.record(hidden(p, 'POST'));
      expect(await stats()).toEqual({
        participation: '4',
        agreeReceived: '1',
        picks: '0',
      });
      if (action === 'DELETE')
        await service.record({
          ...c,
          active: false,
          version: 2,
          eventId: id('evt'),
        });
      else await service.record(hidden(c, 'COMMENT'));
      // Own reaction and selected vote still count; deleted/hidden authored comment and its received AGREE do not.
      expect(await stats()).toEqual({
        participation: '3',
        agreeReceived: '0',
        picks: '0',
      });
      await service.record({ ...c, eventId: id('evt') });
      await service.record({ ...a, eventId: id('evt') });
      expect(await stats()).toEqual({
        participation: '3',
        agreeReceived: '0',
        picks: '0',
      });
    },
  );
  it.each([2, 4])(
    'never lets regional awards grant or revoke a v3 canonical title at stage %i',
    async (stage) => {
      await participation(10);
      if (stage === 4) {
        const c = await comment();
        for (let i = 2; i <= 11; i++) await agree(c, String(i));
        for (let i = 0; i < 5; i++) await winner();
      }
      const run = await new RegionalRankingWorker(db, titles).recompute(
        '1159063000',
      );
      expect(run).not.toBeNull();
      const before = await db.query(
        'SELECT * FROM user_badge_history ORDER BY id',
      );
      const context = { eventId: id('evt'), correlationId: 'ranking-v3' };
      for (const selected of [true, false])
        await db.transaction(async (m) => {
          await titles.lock(m);
          await titles.changeRegional(
            m,
            '1',
            '1159063000',
            run!,
            selected,
            context,
            { reason: 'RANKING_TEST' },
          );
        });
      expect((await progress()).currentStage).toBe(stage);
      expect(
        await db.query('SELECT * FROM user_badge_history ORDER BY id'),
      ).toEqual(before);
    },
  );
  it('keeps compare read-only and repeated silent title reconciliation idempotent, preserving credits and prior history', async () => {
    await participation(10);
    const before = await db.query(
      'SELECT * FROM user_badge_history ORDER BY id',
    );
    const policies = await db.query(
      'SELECT * FROM reward_policies ORDER BY version',
    );
    const compare = await db.transaction('REPEATABLE READ', async (m) => {
      await m.query('SET TRANSACTION READ ONLY');
      return titles.v3.compare(m, '1');
    });
    expect(compare.stage).toBe(2);
    expect(
      await db.query('SELECT * FROM reward_policies ORDER BY version'),
    ).toEqual(policies);
    for (let i = 0; i < 2; i++)
      await db.transaction((m) =>
        titles.syncUser(m, '1', {
          eventId: 'title-v3:operation:1',
          correlationId: 'operation',
          notificationMode: 'silent',
        }),
      );
    expect(
      await db.query('SELECT * FROM user_badge_history ORDER BY id'),
    ).toEqual(before);
    expect(await db.query('SELECT * FROM credit_ledger')).toHaveLength(0);
    expect(await db.query('SELECT * FROM user_growth')).toHaveLength(0);
    expect((await progress()).highestAchievedStage).toBe(2);
  });
  it('keeps v2 grants and policy definition unchanged while v3 awards are OFF', async () => {
    vi.stubEnv('USER_TITLES_V3_ENABLED', 'false');
    titles = new TitleService(titles.settings);
    service = new ActivityService(
      db,
      new RewardEngine(DISABLED_POLICY),
      titles,
    );
    await participation(10);
    expect((await progress()).policyVersion).toBe('wgo-titles-v2');
    expect((await progress()).currentStage).toBe(1);
    await selection(id('post'), id('comment'), 1);
    expect(await db.query('SELECT * FROM user_title_v3_progress')).toHaveLength(
      0,
    );
    expect(
      (
        await db.query(
          'SELECT definition FROM reward_policies WHERE version=$1',
          [TITLE_POLICY.version],
        )
      )[0].definition,
    ).toEqual(TITLE_POLICY);
    expect(
      await db.query('SELECT * FROM reward_policies WHERE version=$1', [
        TITLE_V3_POLICY.version,
      ]),
    ).toHaveLength(0);
    expect(
      (await db.query('SELECT policy_version FROM user_badge_history')).every(
        (r: { policy_version: string }) => r.policy_version === 'wgo-titles-v2',
      ),
    ).toBe(true);
    expect(await db.query('SELECT * FROM credit_ledger')).toHaveLength(0);
    expect(
      (await db.transaction((m) => new TitleV3(false).compare(m, '1'))).stage,
    ).toBe(2);
    const legacy = await db.query(
      'SELECT * FROM user_badge_history ORDER BY id',
    );
    const badge = await db.query(
      'SELECT * FROM user_badges WHERE user_id=1 AND revoked_at IS NULL',
    );
    vi.stubEnv('USER_TITLES_V3_ENABLED', 'true');
    const activated = new TitleService(titles.settings);
    await db.transaction((m) =>
      activated.syncUser(m, '1', {
        eventId: 'v3-switch',
        correlationId: 'v3-switch',
        notificationMode: 'silent',
      }),
    );
    const after = await db.query(
      'SELECT * FROM user_badge_history ORDER BY id',
    );
    expect(after.slice(0, legacy.length)).toEqual(legacy);
    expect(after.at(-1).policy_version).toBe('wgo-titles-v3');
    expect(
      await db.query(
        'SELECT * FROM user_badges WHERE user_id=1 AND badge_id=$1',
        [badge[0].badge_id],
      ),
    ).toEqual(badge);
  });
  it('defaults OFF and rejects ambiguous flag values', () => {
    expect(titleV3Enabled({})).toBe(false);
    expect(() => titleV3Enabled({ USER_TITLES_V3_ENABLED: 'yes' })).toThrow();
  });
});
