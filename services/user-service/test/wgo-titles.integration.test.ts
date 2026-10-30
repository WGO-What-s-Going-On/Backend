import 'reflect-metadata';
import { beforeAll, afterAll, beforeEach, describe, it, expect } from 'vitest';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'node:crypto';
import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddActivityRewards1792190000000 } from '../src/database/migrations/1792190000000-AddActivityRewards.js';
import { CompleteActivityRewards1793360000000 } from '../src/database/migrations/1793360000000-CompleteActivityRewards.js';
import { ActivateWgoTitles1793400000000 } from '../src/database/migrations/1793400000000-ActivateWgoTitles.js';
import { seedBadgeCatalog } from '../src/rewards/badge-catalog.js';
import { ActivityService } from '../src/rewards/activity.service.js';
import { RewardEngine } from '../src/rewards/reward-engine.js';
import { DISABLED_POLICY } from '../src/rewards/reward-policy.js';
import { TitleService } from '../src/rewards/title.service.js';
import { RegionalRankingWorker } from '../src/rewards/regional-ranking.worker.js';
import { RewardMaintenanceWorker } from '../src/rewards/reward-maintenance.worker.js';
import {
  rankingWindow,
  loadTitleSettings,
} from '../src/rewards/title-policy.js';
import {
  PostRewardsConsumer,
  POST_STREAM,
  REWARDS_DLQ,
  REWARDS_GROUP,
} from '../src/rewards/post-rewards.consumer.js';
import {
  parsePostEvent,
  type ActivityInput,
} from '../src/rewards/post-event.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { RedisStreamsPublisher } from '../src/outbox/redis-streams.publisher.js';

const name = `wgo_title_policy_${process.pid}_${Date.now()}`,
  redisUrl = 'redis://127.0.0.1:6379/11';
const NOW = new Date('2026-10-31T12:00:00+09:00'),
  window = rankingWindow(NOW),
  R1 = '1159063000',
  R2 = '1159064000';
const post = () => `post_${randomUUID()}`,
  comment = () => `comment_${randomUUID()}`,
  event = () => `evt_${randomUUID()}`;
function activity(
  kind: ActivityInput['kind'],
  actorId = '1',
  postId = post(),
  key = comment(),
): ActivityInput {
  return {
    kind,
    actorId,
    postId,
    key,
    eventId: event(),
    correlationId: 'confirmed-title-test',
    beneficiaryId: null,
    reactionType: null,
    version: 1,
    active: true,
    ...(kind === 'COMMENT' ? { commentId: key } : {}),
    ...(kind === 'POST' ? { key: postId, postStatus: 'ACTIVE' as const } : {}),
  };
}
function vote(
  userId: string,
  postId = post(),
  closedAt = new Date(window.end.getTime() - 3600000).toISOString(),
): ActivityInput {
  return {
    ...activity('VOTE_WIN', userId, postId, `vote:${postId}`),
    beneficiaryId: userId,
    resultId: postId,
    commentId: comment(),
    occurredAt: closedAt,
    postRegion: { code: R1, name: '상도1동', type: 'H', version: 1 },
  };
}
describe('Confirmed WGO titles / real PostgreSQL and Redis', () => {
  let admin: DataSource,
    db: DataSource,
    redis: Redis,
    service: ActivityService,
    titles: TitleService,
    ranker: RegionalRankingWorker;
  let ownsKeys = false;
  const consumers: PostRewardsConsumer[] = [];
  beforeAll(async () => {
    const c = configuration().database,
      options = {
        type: 'postgres' as const,
        host: c.host,
        port: c.port,
        username: c.username,
        password: c.password,
      };
    admin = new DataSource({ ...options, database: 'postgres' });
    await admin.initialize();
    await admin.query(`CREATE DATABASE "${name}"`);
    db = new DataSource({
      ...options,
      database: name,
      entities: [...USER_SERVICE_ENTITIES],
      migrations: [
        InitialUserServiceSchema1789990707351,
        AddActivityRewards1792190000000,
        CompleteActivityRewards1793360000000,
        ActivateWgoTitles1793400000000,
      ],
    });
    await db.initialize();
    await db.runMigrations();
    redis = new Redis(redisUrl);
    await redis.ping();
    if (await redis.exists(POST_STREAM, REWARDS_DLQ, 'user:events'))
      throw new Error(
        'DB11 already has reward test streams; use an isolated instance',
      );
    ownsKeys = true;
  }, 30000);
  afterAll(async () => {
    for (const c of consumers) await c.onModuleDestroy();
    if (redis) {
      if (ownsKeys) await redis.del(POST_STREAM, REWARDS_DLQ, 'user:events');
      redis.disconnect();
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${name}" WITH(FORCE)`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    await db.query(
      'TRUNCATE users,reward_policies,user_activities,reward_posts,reward_inbox,outbox_events,reward_post_regions,reward_post_region_history RESTART IDENTITY CASCADE',
    );
    await db.query(
      "INSERT INTO users(id,nickname,status,created_at,updated_at) SELECT i,'Title user '||i,'ACTIVE',now(),now() FROM generate_series(1,500) i",
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
    ranker = new RegionalRankingWorker(db, titles);
    await redis.del(POST_STREAM, REWARDS_DLQ, 'user:events');
  });
  async function has(code: string, user = '1') {
    return (
      (
        await db.query(
          `SELECT 1 FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=$1 AND b.code=$2 AND ub.revoked_at IS NULL`,
          [user, code],
        )
      ).length > 0
    );
  }
  async function history(code: string, action: string) {
    return (
      await db.query(
        'SELECT count(*) FROM user_badge_history h JOIN badges b ON b.id=h.badge_id WHERE b.code=$1 AND h.action=$2',
        [code, action],
      )
    )[0].count;
  }
  function reaction(
    c: ActivityInput,
    actorId: string,
    type = 'AGREE',
    version = 1,
    active = true,
  ): ActivityInput {
    return {
      ...activity(
        'COMMENT_REACTION',
        actorId,
        c.postId,
        `${c.commentId}:reaction:${actorId}:${type}`,
      ),
      commentId: c.commentId!,
      beneficiaryId: c.actorId,
      reactionType: type,
      version,
      active,
    };
  }
  async function qualifyingComments(n: number, perComment = 10) {
    const comments: ActivityInput[] = [];
    for (let i = 0; i < n; i++) {
      const c = activity('COMMENT');
      comments.push(c);
      await service.record(c);
      for (let j = 0; j < perComment; j++)
        await service.record(reaction(c, String(100 + j)));
    }
    return comments;
  }
  async function competitors(
    n: number,
    region = R1,
    offset = 0,
    closedAt = new Date(window.end.getTime() - 3600000).toISOString(),
  ) {
    // Bulk fixtures are original activities, not fake cached scores; normal title evaluation still runs against PostgreSQL.
    const rows = Array.from({ length: n * 5 }, (_, i) => ({
      ...vote(String(offset + Math.floor(i / 5) + 1), post(), closedAt),
      region,
    }));
    await db.query(
      `INSERT INTO user_activities(activity_key,post_id,kind,actor_id,beneficiary_id,reaction_type,version,active,event_id,correlation_id,comment_id,result_id,occurred_at,source_time_verified)
      SELECT key,"postId",'VOTE_WIN',"actorId"::bigint,"beneficiaryId"::bigint,NULL,1,true,"eventId",'bulk-vote-fixture',"commentId","resultId","occurredAt"::timestamptz,true
      FROM jsonb_to_recordset($1) AS x(key text,"postId" text,"actorId" text,"beneficiaryId" text,"eventId" text,"commentId" text,"resultId" text,"occurredAt" text)`,
      [JSON.stringify(rows)],
    );
    await db.query(
      `INSERT INTO reward_post_regions(post_id,version,region_code,region_name,event_id)
      SELECT "postId",1,region,'District fixture',"eventId" FROM jsonb_to_recordset($1) AS x("postId" text,region text,"eventId" text)`,
      [JSON.stringify(rows)],
    );
    for (let i = 1; i <= n; i++)
      await service.refreshUserTitles(String(offset + i));
    return rows;
  }
  it('defaults confirmed titles ON independently of default-OFF credits and an unavailable region contract', async () => {
    expect(loadTitleSettings({})).toEqual({
      enabled: true,
      regionalRankingEnabled: true,
      regionContract: 'none',
    });
    const ordinary = new ActivityService(db, new RewardEngine(DISABLED_POLICY));
    for (let i = 0; i < 10; i++) await ordinary.record(activity('COMMENT'));
    const result = await ordinary.summary('1');
    expect(result.rewardsEnabled).toBe(false);
    expect(await has('NEWS_SOURCE')).toBe(true);
    expect(result.titles.regionalRanking).toMatchObject({
      ready: false,
      status: 'CONTRACT_UNAVAILABLE',
    });
    expect(
      (await db.query('SELECT count(*) FROM credit_ledger'))[0].count,
    ).toBe('0');
  });
  it('awards participation at 10, not 9; presence, redelivery and reaction cycles do not inflate it', async () => {
    const comments = [];
    for (let i = 0; i < 9; i++) {
      const c = activity('COMMENT');
      comments.push(c);
      await service.record(c);
      await service.record({
        ...activity('PARTICIPATION'),
        postId: c.postId,
        key: `presence:${c.postId}`,
      });
    }
    expect(await has('NEWS_SOURCE')).toBe(false);
    await service.record(comments[0]!);
    const c = comments[0]!,
      r = {
        ...activity('POST_REACTION', '1', c.postId, `reaction:${c.postId}:1`),
        reactionType: 'HELPFUL',
        beneficiaryId: '2',
      };
    await service.record(r);
    expect(await has('NEWS_SOURCE')).toBe(true);
    await service.record({ ...r, eventId: event(), version: 2, active: false });
    expect(await has('NEWS_SOURCE')).toBe(false);
    await service.record({ ...r, eventId: event(), version: 3 });
    await service.record({ ...r, eventId: event() });
    expect((await titles.metrics(db.manager, '1')).participation).toBe('10');
    expect((await service.summary('1')).titles).toMatchObject({
      highestAchievedStage: 1,
    });
    expect(await history('NEWS_SOURCE', 'GRANTED')).toBe('2');
  });
  it('requires 10 distinct comments with 10 distinct AGREE users each, and retains achievement history after revocation', async () => {
    const cs = await qualifyingComments(9);
    expect(await has('REPORTER')).toBe(false);
    const tenth = activity('COMMENT');
    await service.record(tenth);
    for (let i = 0; i < 9; i++)
      await service.record(reaction(tenth, String(100 + i)));
    await service.record(reaction(tenth, '109', 'HELPFUL'));
    await service.record(reaction(tenth, '110', 'DIFFERENT'));
    await service.record(reaction(tenth, '1'));
    expect(await has('REPORTER')).toBe(false);
    const last = reaction(tenth, '109');
    await service.record(last);
    await service.record({ ...last, eventId: event() });
    expect(await has('REPORTER')).toBe(true);
    await service.record({
      ...last,
      eventId: event(),
      version: 2,
      active: false,
    });
    expect(await has('REPORTER')).toBe(false);
    expect((await service.summary('1')).titles.stages[1]).toMatchObject({
      progress: '9',
      remaining: '1',
      achieved: true,
    });
    await service.record({ ...last, eventId: event(), version: 3 });
    expect(await has('REPORTER')).toBe(true);
    await service.record({
      ...cs[0]!,
      eventId: event(),
      version: 2,
      active: false,
    });
    expect(await has('REPORTER')).toBe(false);
    expect((await service.summary('1')).titles.highestAchievedStage).toBe(2);
  }, 30000);
  it('does not treat 100 AGREE reactions on a single comment as 10 qualified comments', async () => {
    await qualifyingComments(1, 100);
    expect(await has('REPORTER')).toBe(false);
    expect((await titles.metrics(db.manager, '1')).reporter_comments).toBe('1');
  }, 30000);

  it('can disable regional updates without disabling confirmed titles, and can explicitly disable title evaluation', async () => {
    titles = new TitleService({
      enabled: true,
      regionalRankingEnabled: false,
      regionContract: 'post-region-v1',
    });
    service = new ActivityService(
      db,
      new RewardEngine(DISABLED_POLICY),
      titles,
    );
    ranker = new RegionalRankingWorker(db, titles);
    for (let i = 0; i < 5; i++) await service.record(vote('1'));
    expect(await has('CORRESPONDENT')).toBe(true);
    expect(await ranker.recompute(R1, NOW)).toBeNull();
    const disabled = new ActivityService(
      db,
      new RewardEngine(DISABLED_POLICY),
      new TitleService({
        enabled: false,
        regionalRankingEnabled: true,
        regionContract: 'none',
      }),
    );
    for (let i = 0; i < 10; i++)
      await disabled.record(activity('COMMENT', '2'));
    expect(await has('NEWS_SOURCE', '2')).toBe(false);
  });
  it('counts four/five unique vote results, deduplicates redelivery and revokes deleted comment selections', async () => {
    const votes = [];
    for (let i = 0; i < 4; i++) {
      const v = vote('1');
      votes.push(v);
      await service.record(v);
    }
    expect(await has('CORRESPONDENT')).toBe(false);
    const fifth = vote('1');
    await service.record(fifth);
    await service.record(fifth);
    await service.record({ ...fifth, eventId: event() });
    expect(await has('CORRESPONDENT')).toBe(true);
    expect((await titles.metrics(db.manager, '1')).representative_wins).toBe(
      '5',
    );
    await service.record({
      ...activity('COMMENT', '1', fifth.postId, fifth.commentId),
      version: 2,
      active: false,
    });
    expect(await has('CORRESPONDENT')).toBe(false);
    expect((await service.summary('1')).titles.highestAchievedStage).toBe(3);
  });
  it('retains naturally expired selections and excludes post/comment deletions arriving before wins', async () => {
    for (let i = 0; i < 4; i++) await service.record(vote('1'));
    const v = vote('1');
    await service.record({
      ...activity('POST', '1', v.postId),
      active: false,
      version: 2,
      postStatus: 'EXPIRED',
    });
    await service.record(v);
    expect(await has('CORRESPONDENT')).toBe(true);
    await service.record({
      ...activity('POST', '1', v.postId),
      active: false,
      version: 3,
      postStatus: 'DELETED',
    });
    expect(await has('CORRESPONDENT')).toBe(false);
    const late = vote('1');
    await service.record({
      ...activity('COMMENT', '1', late.postId, late.commentId),
      version: 2,
      active: false,
    });
    await service.record(late);
    expect((await titles.metrics(db.manager, '1')).representative_wins).toBe(
      '4',
    );
  });
  it.each([
    [5, 0],
    [9, 0],
    [10, 1],
    [19, 1],
    [20, 2],
    [50, 5],
    [100, 10],
  ])(
    'selects %s eligible local correspondents into %s slots',
    async (n, slots) => {
      await competitors(n);
      const id = await ranker.recompute(R1, NOW);
      const [run] = await db.query(
        'SELECT competitors,slots FROM regional_ranking_runs WHERE id=$1',
        [id],
      );
      expect(run).toMatchObject({
        competitors: String(n),
        slots: String(slots),
      });
      expect(await history('CLAIRVOYANT', 'GRANTED')).toBe(String(slots));
      const previous = await db.query('SELECT count(*) FROM outbox_events');
      await ranker.recompute(R1, NOW);
      expect((await db.query('SELECT count(*) FROM outbox_events'))[0]).toEqual(
        previous[0],
      );
    },
    30000,
  );
  it('excludes users without five valid selections even when their regional score is positive', async () => {
    await competitors(9);
    await service.record(vote('10'));
    await ranker.recompute(R1, NOW);
    expect(await history('CLAIRVOYANT', 'GRANTED')).toBe('0');
    expect(
      (await db.query('SELECT competitors FROM regional_ranking_runs'))[0]
        .competitors,
    ).toBe('9');
  });
  it('uses a deterministic tie break and records immutable score evidence for replay', async () => {
    await competitors(10);
    const run = await ranker.recompute(R1, NOW);
    const rows = await db.query(
      'SELECT user_id,rank,selected,evidence FROM regional_ranking_entries WHERE run_id=$1 ORDER BY rank',
      [run],
    );
    expect(rows[0]).toMatchObject({ user_id: '1', rank: '1', selected: true });
    expect(rows[0].evidence).toHaveLength(5);
    expect(rows[1]).toMatchObject({ user_id: '2', rank: '2', selected: false });
    expect(
      (await titles.progress(db.manager, '1', NOW)).regionalRanking.regions[0],
    ).toMatchObject({ regionCode: R1, rank: '1', selected: true });
  });
  it('uses [Seoul midnight minus 30 days, Seoul midnight) and lets the next midnight admit new results', async () => {
    const rows = await competitors(10);
    const first = rows.filter((x) => x.actorId === '1');
    for (const a of first)
      await db.query(
        'UPDATE user_activities SET occurred_at=$2 WHERE activity_key=$1',
        [a.key, new Date(window.start.getTime() - 1)],
      );
    await db.query(
      'UPDATE user_activities SET occurred_at=$2 WHERE activity_key=$1',
      [first[0]!.key, window.start],
    );
    await db.query(
      'UPDATE user_activities SET occurred_at=$2 WHERE activity_key=$1',
      [first[1]!.key, window.end],
    );
    const run = await ranker.recompute(R1, NOW);
    expect(
      (
        await db.query(
          'SELECT score FROM regional_ranking_entries WHERE run_id=$1 AND user_id=1',
          [run],
        )
      )[0].score,
    ).toBe('1');
    const tomorrow = new Date(NOW.getTime() + 86400000);
    await ranker.recompute(R1, tomorrow);
    expect(
      (await db.query('SELECT count(*) FROM regional_ranking_runs'))[0].count,
    ).toBe('2');
    await expect(ranker.recompute(R1, NOW)).rejects.toThrow('Historical');
  });
  it('grants, revokes and regrants regional titles for delayed results without revoking correspondent', async () => {
    await competitors(10);
    await ranker.recompute(R1, NOW);
    expect(await has('CLAIRVOYANT', '1')).toBe(true);
    const late = vote('2');
    await service.record(late);
    await ranker.recompute(R1, NOW);
    expect(await has('CLAIRVOYANT', '1')).toBe(false);
    expect(await has('CORRESPONDENT', '1')).toBe(true);
    expect(await has('CLAIRVOYANT', '2')).toBe(true);
    for (let i = 0; i < 2; i++) await service.record(vote('1'));
    await ranker.recompute(R1, NOW);
    expect(await has('CLAIRVOYANT', '1')).toBe(true);
    expect(await history('CLAIRVOYANT', 'GRANTED')).toBe('3');
    expect((await service.summary('1')).titles.highestAchievedStage).toBe(4);
  });
  it('keeps districts independent and supports multiple simultaneous regional titles', async () => {
    const rows = await competitors(10);
    await competitors(10, R2);
    await ranker.recompute(R1, NOW);
    await ranker.recompute(R2, NOW);
    expect(
      (
        await db.query(
          'SELECT region_code FROM user_regional_badges WHERE user_id=1 AND revoked_at IS NULL ORDER BY region_code',
        )
      ).map((r: { region_code: string }) => r.region_code),
    ).toEqual([R1, R2]);
    const r1run = (
      await db.query(
        'SELECT run_id FROM regional_ranking_heads WHERE region_code=$1',
        [R1],
      )
    )[0].run_id;
    await service.record({
      ...vote('2'),
      postRegion: { code: R2, name: '상도2동', type: 'H', version: 1 },
    });
    await ranker.recompute(R2, NOW);
    expect(
      (
        await db.query(
          'SELECT run_id FROM regional_ranking_heads WHERE region_code=$1',
          [R1],
        )
      )[0].run_id,
    ).toBe(r1run);
    expect(await has('CLAIRVOYANT', '1')).toBe(true);
    expect(rows[0]!.postId).toMatch(/^post_/);
  });
  it('serializes duplicate schedulers and catches up missed midnights after restart', async () => {
    await competitors(20);
    const second = new RegionalRankingWorker(db, titles);
    await Promise.all([ranker.run(NOW), second.run(NOW)]);
    expect(
      (await db.query('SELECT count(*) FROM regional_ranking_runs'))[0].count,
    ).toBe('1');
    expect(await history('CLAIRVOYANT', 'GRANTED')).toBe('2');
    await new RegionalRankingWorker(db, titles).run(
      new Date(NOW.getTime() + 3 * 86400000),
    );
    expect(
      (
        await db.query(
          'SELECT max(ranking_date)::text AS date FROM regional_ranking_runs',
        )
      )[0].date,
    ).toBe(rankingWindow(new Date(NOW.getTime() + 3 * 86400000)).date);
    expect(await history('CLAIRVOYANT', 'GRANTED')).toBe('2');
  });
  it('rolls back ranking snapshot, awards and outbox on deferred PostgreSQL commit failure then retries', async () => {
    await competitors(10);
    await db.query(`CREATE FUNCTION reject_title_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'title commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER reject_title_commit AFTER INSERT ON regional_ranking_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_title_commit()`);
    try {
      await expect(ranker.recompute(R1, NOW)).rejects.toThrow(
        'title commit failure',
      );
    } finally {
      await db.query(
        'DROP TRIGGER reject_title_commit ON regional_ranking_runs;DROP FUNCTION reject_title_commit()',
      );
    }
    expect(
      (await db.query('SELECT count(*) FROM regional_ranking_runs'))[0].count,
    ).toBe('0');
    expect(await has('CLAIRVOYANT')).toBe(false);
    await ranker.recompute(R1, NOW);
    expect(await history('CLAIRVOYANT', 'GRANTED')).toBe('1');
  });
  it.each(['SUSPENDED', 'WITHDRAWAL_PENDING', 'WITHDRAWN'])(
    'excludes %s accounts, retains achievement and recalculates competition',
    async (status) => {
      await competitors(10);
      await ranker.recompute(R1, NOW);
      await db.query('UPDATE users SET status=$2 WHERE id=$1', ['1', status]);
      await new RewardMaintenanceWorker(
        db,
        service,
        new RewardEngine(DISABLED_POLICY),
        titles,
      ).run();
      await ranker.recompute(R1, NOW);
      expect(await has('CLAIRVOYANT')).toBe(false);
      expect(await has('CORRESPONDENT')).toBe(false);
      expect((await service.summary('1')).titles.highestAchievedStage).toBe(4);
      expect(
        (
          await db.query(
            'SELECT r.competitors FROM regional_ranking_heads h JOIN regional_ranking_runs r ON r.id=h.run_id WHERE h.region_code=$1',
            [R1],
          )
        )[0].competitors,
      ).toBe('9');
    },
  );

  it('keeps a retracted newer region when an older vote snapshot arrives later', async () => {
    const v = vote('1');
    await service.record({
      ...activity('POST', '1', v.postId),
      regionUpdate: { version: 3, region: null },
    });
    await service.record(v);
    expect(
      (
        await db.query(
          'SELECT version,region_code FROM reward_post_regions WHERE post_id=$1',
          [v.postId],
        )
      )[0],
    ).toMatchObject({ version: '3', region_code: null });
    expect((await titles.metrics(db.manager, '1')).representative_wins).toBe(
      '1',
    );
  });
  it('revises activity regions without moving them on user profile changes, and preserves old snapshots', async () => {
    const rows = await competitors(10);
    const original = await ranker.recompute(R1, NOW),
      v = rows[0]!;
    await db.query("UPDATE users SET nickname='Moved user' WHERE id=1");
    expect(
      (
        await db.query(
          'SELECT region_code FROM reward_post_regions WHERE post_id=$1',
          [v.postId],
        )
      )[0].region_code,
    ).toBe(R1);
    const update = {
      ...activity('POST', '1', v.postId),
      regionUpdate: {
        version: 2,
        region: { code: R2, name: '상도2동', type: 'H' as const, version: 2 },
      },
    };
    await service.record(update);
    await service.record({ ...update, eventId: event() });
    await ranker.recompute(R1, NOW);
    await ranker.recompute(R2, NOW);
    expect(
      (
        await db.query(
          'SELECT evidence FROM regional_ranking_entries WHERE run_id=$1 AND user_id=1',
          [original],
        )
      )[0].evidence[0].regionCode,
    ).toBe(R1);
    await expect(
      service.record({
        ...update,
        eventId: event(),
        regionUpdate: {
          version: 2,
          region: { code: R1, name: 'Other', type: 'H', version: 2 },
        },
      }),
    ).rejects.toThrow('Conflicting');
    await service.record({
      ...update,
      eventId: event(),
      regionUpdate: { version: 3, region: null },
    });
    await ranker.recompute(R2, NOW);
    expect(
      (
        await db.query(
          'SELECT region_code FROM reward_post_regions WHERE post_id=$1',
          [v.postId],
        )
      )[0].region_code,
    ).toBeNull();
    expect(
      (
        await db.query(
          'SELECT count(*) FROM reward_post_region_history WHERE post_id=$1',
          [v.postId],
        )
      )[0].count,
    ).toBe('2');
  });
  it('fails closed for incomplete attribution/timestamps while leaving the first three titles operational', async () => {
    const rows = await competitors(10);
    await db.query('DELETE FROM reward_post_regions WHERE post_id=$1', [
      rows[0]!.postId,
    ]);
    await ranker.recompute(R1, NOW);
    expect(await history('CLAIRVOYANT', 'GRANTED')).toBe('0');
    expect(await has('CORRESPONDENT')).toBe(true);
    expect(
      (await titles.progress(db.manager, '1', NOW)).regionalRanking,
    ).toMatchObject({
      ready: false,
      status: 'INCOMPLETE_SOURCE_DATA',
      missingRegionResults: '1',
    });
    await db.query(
      'UPDATE user_activities SET source_time_verified=false WHERE activity_key=$1',
      [rows[1]!.key],
    );
    expect(
      (await titles.progress(db.manager, '1', NOW)).regionalRanking
        .unverifiedTimeResults,
    ).toBe('1');
  });
  it('consumes the proposed Post region contract only when explicitly configured and publishes title metadata to real Redis', async () => {
    const consumer = new PostRewardsConsumer(
      new ConfigService({
        redis: { url: redisUrl },
        rewards: {
          regionContract: 'post-region-v1',
          pendingIdleMs: 1,
          maxAttempts: 2,
        },
      }),
      service,
    );
    consumers.push(consumer);
    for (let i = 0; i < 5; i++) {
      const a = vote('1'),
        type = 'PostVoteWon',
        value = {
          eventId: a.eventId,
          eventType: type,
          schemaVersion: 1,
          producer: 'post-service',
          aggregateId: a.postId,
          correlationId: a.correlationId,
          occurredAt: a.occurredAt,
          activityVersion: 1,
          vote: {
            postId: a.postId,
            resultId: a.resultId,
            commentId: a.commentId,
            winnerAuthorId: 1,
            votes: 2,
            closedAt: a.occurredAt,
          },
          postRegion: a.postRegion,
        };
      const fields = {
        eventId: a.eventId,
        eventType: type,
        data: JSON.stringify(value),
      };
      expect(parsePostEvent(fields)!.postRegion).toBeUndefined();
      await redis.xadd(POST_STREAM, '*', ...Object.entries(fields).flat());
      await consumer.pollOnce();
    }
    expect(await has('CORRESPONDENT')).toBe(true);
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))[0]).toBe(0);
    const config = new ConfigService({
      redis: { url: redisUrl },
      outbox: { redisTimeoutMs: 2000, batchSize: 100, pollIntervalMs: 1000 },
    });
    const outbox = new OutboxWorker(
      db,
      new RedisStreamsPublisher(config),
      config,
    );
    try {
      await outbox.publishPending();
      const fields = (await redis.xrange('user:events', '-', '+'))[0]![1];
      const data = JSON.parse(
        Object.fromEntries(
          Array.from({ length: fields.length / 2 }, (_, i) => [
            fields[i * 2],
            fields[i * 2 + 1],
          ]),
        ).data!,
      );
      expect(data).toMatchObject({
        version: 1,
        type: 'USER_BADGE_GRANTED',
        payload: { badgeCode: 'CORRESPONDENT', badgeName: '특파원', stage: 3 },
      });
    } finally {
      await outbox.onModuleDestroy();
    }
  });
  it('keeps existing users, ledger and awards through title migration rollback and seed rerun', async () => {
    for (let i = 0; i < 10; i++) await service.record(activity('COMMENT'));
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const before = await runner.query('SELECT * FROM user_badges');
      const migration = new ActivateWgoTitles1793400000000();
      await migration.down(runner);
      await migration.up(runner);
      await seedBadgeCatalog(runner.manager);
      expect(await runner.query('SELECT * FROM user_badges')).toEqual(before);
      expect((await runner.query('SELECT count(*) FROM users'))[0].count).toBe(
        '500',
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
});
