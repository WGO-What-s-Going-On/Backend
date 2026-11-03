import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'vitest';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';
import { ActivityService } from '../src/rewards/activity.service.js';
import { RewardEngine } from '../src/rewards/reward-engine.js';
import { DISABLED_POLICY } from '../src/rewards/reward-policy.js';
import { TitleService } from '../src/rewards/title.service.js';
import { RegionalRankingWorker } from '../src/rewards/regional-ranking.worker.js';
import {
  PostRewardsConsumer,
  POST_STREAM,
  REWARDS_DLQ,
  REWARDS_GROUP,
} from '../src/rewards/post-rewards.consumer.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { RedisStreamsPublisher } from '../src/outbox/redis-streams.publisher.js';
import { rankingWindow } from '../src/rewards/title-policy.js';
import type { ActivityInput } from '../src/rewards/post-event.js';
import {
  eventId,
  NOW,
  R1,
  voteFact,
  voteTestDatabase,
} from './vote-test-context.js';

const { event: postEvent } = await import(
  new URL('../../post-service/src/post/application/event.ts', import.meta.url)
    .href
);
const { serializePostEvent } = await import(
  new URL(
    '../../post-service/src/post/infrastructure/post-event-envelope.ts',
    import.meta.url,
  ).href
);
const redisUrl = 'redis://127.0.0.1:6379/10';
function fields(fact: ActivityInput) {
  const candidate = fact.kind === 'VOTE_CANDIDATE';
  const target = {
    postId: fact.postId,
    commentId: fact.commentId,
    ...(candidate
      ? {
          authorId: Number(fact.actorId),
          scoreAtSelection: fact.scoreAtSelection,
          selectedAt: new Date(fact.occurredAt!),
        }
      : {
          resultId: fact.resultId,
          winnerAuthorId: Number(fact.actorId),
          votes: 2,
          closedAt: new Date(fact.occurredAt!),
        }),
    ...(fact.regionCode === undefined ? {} : { regionCode: fact.regionCode }),
  };
  const row = postEvent(
    fact.postId,
    candidate ? 'PostVoteCandidateSelected' : 'PostVoteWon',
    { activityVersion: 1, [candidate ? 'candidate' : 'vote']: target },
    NOW,
  );
  row.eventId = fact.eventId;
  return {
    eventId: row.eventId,
    eventType: row.eventType,
    data: serializePostEvent(row),
  };
}
describe('Actual Post serialization -> Redis -> User PostgreSQL -> User Outbox', () => {
  let context: Awaited<ReturnType<typeof voteTestDatabase>>, redis: Redis;
  let service: ActivityService,
    titles: TitleService,
    ranker: RegionalRankingWorker;
  const consumers: PostRewardsConsumer[] = [];
  let ownsKeys = false;
  beforeAll(async () => {
    context = await voteTestDatabase('vote_consumer');
    redis = new Redis(redisUrl);
    await redis.ping();
    if (await redis.exists(POST_STREAM, REWARDS_DLQ, 'user:events'))
      throw new Error('DB10 is not isolated');
    ownsKeys = true;
  }, 30000);
  afterAll(async () => {
    if (redis) {
      if (ownsKeys) await redis.del(POST_STREAM, REWARDS_DLQ, 'user:events');
      redis.disconnect();
    }
    await context?.close();
  });
  beforeEach(async () => {
    await context.fresh();
    await redis.del(POST_STREAM, REWARDS_DLQ, 'user:events');
    titles = new TitleService();
    service = new ActivityService(
      context.db,
      new RewardEngine(DISABLED_POLICY),
      titles,
    );
    ranker = new RegionalRankingWorker(context.db, titles);
  });
  afterEach(async () => {
    for (const c of consumers.splice(0)) await c.onModuleDestroy();
  });
  function consumer() {
    const c = new PostRewardsConsumer(
      new ConfigService({
        redis: { url: redisUrl },
        rewards: { pendingIdleMs: 1, maxAttempts: 3 },
      }),
      service,
    );
    consumers.push(c);
    return c;
  }
  async function send(fact: ActivityInput) {
    return redis.xadd(POST_STREAM, '*', ...Object.entries(fields(fact)).flat());
  }
  it('publishes one regional notification for the actual state transition and no extra one on replay', async () => {
    const c = consumer(),
      start = rankingWindow(NOW).start;
    for (let user = 1; user <= 10; user++) {
      for (let i = 0; i < 5; i++)
        await send(
          voteFact('VOTE_WIN', String(user), {
            occurredAt: new Date(start.getTime() - 1).toISOString(),
          }),
        );
      await send(voteFact('VOTE_CANDIDATE', String(user)));
    }
    for (let i = 0; i < 3; i++) await c.pollOnce();
    await ranker.run(NOW);
    expect(
      (await context.db.query('SELECT count(*) FROM reward_inbox'))[0].count,
    ).toBe('60');
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))[0]).toBe(0);
    expect(await redis.xlen(REWARDS_DLQ)).toBe(0);
    const config = new ConfigService({
      redis: { url: redisUrl },
      outbox: { redisTimeoutMs: 2000, batchSize: 100, pollIntervalMs: 1000 },
    });
    const publisher = new OutboxWorker(
      context.db,
      new RedisStreamsPublisher(config),
      config,
    );
    try {
      await publisher.publishPending();
      const messages = await redis.xrange('user:events', '-', '+');
      const regional = messages
        .map(([, v]) => {
          const envelope = Object.fromEntries(
            Array.from({ length: v.length / 2 }, (_, i) => [
              v[i * 2]!,
              v[i * 2 + 1]!,
            ]),
          );
          const data = JSON.parse(envelope.data!);
          expect(data.eventId).toBe(envelope.eventId);
          expect(data.type).toBe(envelope.eventType);
          return data;
        })
        .filter((e) => e.payload.badgeCode === 'CLAIRVOYANT');
      expect(regional).toHaveLength(1);
      expect(regional[0]).toMatchObject({
        version: 1,
        producer: 'user-service',
        type: 'USER_BADGE_GRANTED',
        target: { type: 'USER', id: '1' },
        payload: {
          userId: '1',
          badgeCode: 'CLAIRVOYANT',
          policyVersion: 'wgo-titles-v2',
          regionCode: R1,
          rank: '1',
          score: '1',
          rankingRunId: expect.any(String),
        },
      });
      const [raw] = await context.db.query(
        "SELECT * FROM user_activities WHERE kind='VOTE_CANDIDATE' AND actor_id=1",
      );
      const duplicate = voteFact('VOTE_CANDIDATE', '1', {
        postId: raw.post_id,
        commentId: raw.comment_id,
        key: raw.activity_key,
        eventId: raw.event_id,
        occurredAt: raw.occurred_at.toISOString(),
        scoreAtSelection: Number(raw.score_at_selection),
      });
      await send(duplicate);
      await send({ ...duplicate, eventId: eventId() });
      await c.pollOnce();
      await new RegionalRankingWorker(context.db, titles).run(NOW);
      await publisher.publishPending();
      expect(await redis.xlen('user:events')).toBe(messages.length);
    } finally {
      await publisher.onModuleDestroy();
    }
  }, 30000);
  it('recovers an uncommitted candidate from Pending with a new consumer after a PostgreSQL commit failure', async () => {
    const c = consumer();
    await c.pollOnce();
    const fact = voteFact('VOTE_CANDIDATE');
    const id = await send(fact);
    await context.db
      .query(`CREATE FUNCTION reject_candidate_commit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected candidate commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER reject_candidate_commit AFTER INSERT ON user_activities DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_candidate_commit()`);
    try {
      await c.pollOnce();
    } finally {
      await context.db.query(
        'DROP TRIGGER reject_candidate_commit ON user_activities;DROP FUNCTION reject_candidate_commit()',
      );
    }
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))[0]).toBe(1);
    expect(await context.db.query('SELECT * FROM reward_inbox')).toEqual([]);
    await c.onModuleDestroy();
    await redis.xclaim(
      POST_STREAM,
      REWARDS_GROUP,
      'crashed-worker',
      0,
      id!,
      'IDLE',
      60000,
      'JUSTID',
    );
    await consumer().pollOnce();
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))[0]).toBe(0);
    expect(
      (
        await context.db.query(
          'SELECT source_region_code,score_at_selection FROM user_activities',
        )
      )[0],
    ).toEqual({ source_region_code: R1, score_at_selection: '999' });
  });
  it('quarantines an author conflict while preserving the original candidate and its receipt', async () => {
    const c = consumer(),
      fact = voteFact('VOTE_CANDIDATE');
    await send(fact);
    await c.pollOnce();
    await send({
      ...fact,
      actorId: '2',
      beneficiaryId: '2',
      eventId: eventId(),
    });
    await c.pollOnce();
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))[0]).toBe(0);
    const dead = await redis.xrange(REWARDS_DLQ, '-', '+');
    expect(dead).toHaveLength(1);
    const values = dead[0]![1];
    expect(
      Object.fromEntries(
        Array.from({ length: values!.length / 2 }, (_, i) => [
          values![i * 2]!,
          values![i * 2 + 1]!,
        ]),
      ).reason,
    ).toBe('ACTIVITY_CONFLICT');
    expect(
      (await context.db.query('SELECT actor_id FROM user_activities'))[0]
        .actor_id,
    ).toBe('1');
    expect(
      (await context.db.query('SELECT count(*) FROM reward_inbox'))[0].count,
    ).toBe('1');
  });
});
