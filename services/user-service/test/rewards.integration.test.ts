import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { randomUUID } from 'node:crypto';
import request from 'supertest';
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { configuration } from '../src/config/configuration.js';
import { USER_SERVICE_ENTITIES } from '../src/database/entities/index.js';
import { InitialUserServiceSchema1789990707351 } from '../src/database/migrations/1789990707351-InitialUserServiceSchema.js';
import { AddActivityRewards1792190000000 } from '../src/database/migrations/1792190000000-AddActivityRewards.js';
import { ActivityService } from '../src/rewards/activity.service.js';
import { RewardEngine } from '../src/rewards/reward-engine.js';
import {
  DISABLED_POLICY,
  type RewardPolicy,
} from '../src/rewards/reward-policy.js';
import {
  parseFutureRewardInput,
  type ActivityInput,
} from '../src/rewards/post-event.js';
import {
  PostRewardsConsumer,
  POST_STREAM,
  REWARDS_GROUP,
  REWARDS_DLQ,
} from '../src/rewards/post-rewards.consumer.js';
import { RewardsController } from '../src/rewards/rewards.controller.js';
import { RedisStreamsPublisher } from '../src/outbox/redis-streams.publisher.js';
import { OutboxWorker } from '../src/outbox/outbox.worker.js';
import { UsersService } from '../src/users/users.service.js';
import { UserEntity } from '../src/database/entities/user.entity.js';

const name = `wgo_rewards_test_${process.pid}_${Date.now()}`;
const redisUrl = 'redis://127.0.0.1:6379/12';
const fixture: RewardPolicy = {
  ...DISABLED_POLICY,
  version: 'fixture-v1',
  enabled: true,
  postReactions: { HELPFUL: 10 },
  commentReactions: { HELPFUL: 5 },
  voteWinner: 20,
  revokeOnRemoval: true,
  revokeOnPostDeletion: true,
  revokeOnExpiry: true,
  levels: [0, 10, 20],
  badges: [{ code: 'TEST_TITLE', minimumScore: 10, revokeBelow: true }],
};
const post = () => `post_${randomUUID()}`;
const event = () => `evt_${randomUUID()}`;
function reaction(
  postId = post(),
  actorId = '2',
  version = 1,
  active = true,
): ActivityInput {
  return {
    eventId: event(),
    correlationId: 'test-request',
    postId,
    key: `${postId}:POST_REACTION:${actorId}:HELPFUL`,
    kind: 'POST_REACTION',
    actorId,
    beneficiaryId: '1',
    reactionType: 'HELPFUL',
    version,
    active,
  };
}
function envelope(input: ActivityInput) {
  const type = input.active ? 'PostReactionCreated' : 'PostReactionRemoved';
  return {
    eventId: input.eventId,
    eventType: type,
    data: JSON.stringify({
      eventId: input.eventId,
      eventType: type,
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: input.postId,
      correlationId: input.correlationId,
      occurredAt: new Date().toISOString(),
      reaction: {
        postId: input.postId,
        userId: Number(input.actorId),
        type: input.reactionType,
        createdAt: new Date().toISOString(),
        removedAt: new Date().toISOString(),
      },
      postAuthorId: Number(input.beneficiaryId),
      postCategory: 'GENERAL',
      activityVersion: input.version,
    }),
  };
}
describe('Rewards PostgreSQL / Redis integration', () => {
  let admin: DataSource,
    db: DataSource,
    redis: Redis,
    service: ActivityService,
    app: INestApplication;
  let ownsRedisKeys = false;
  const workers: PostRewardsConsumer[] = [];
  beforeAll(async () => {
    const c = configuration().database;
    const options = {
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
      ],
    });
    await db.initialize();
    await db.runMigrations();
    redis = new Redis(redisUrl);
    await redis.ping();
    // Refuse to touch a pre-existing stream even if someone used this test DB for development.
    if (await redis.exists(POST_STREAM, REWARDS_DLQ, 'user:events'))
      throw new Error(
        'Redis DB12 test keys already exist; use an empty test Redis',
      );
    ownsRedisKeys = true;
    const mod = await Test.createTestingModule({
      controllers: [RewardsController],
      providers: [
        {
          provide: ActivityService,
          useValue: {
            summary: (id: string) => service.summary(id),
            history: (id: string, limit: number, before: string | null) =>
              service.history(id, limit, before),
          },
        },
      ],
    }).compile();
    app = mod.createNestApplication();
    await app.init();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    for (const w of workers) await w.onModuleDestroy();
    if (redis) {
      if (ownsRedisKeys)
        await redis.del(POST_STREAM, REWARDS_DLQ, 'user:events');
      redis.disconnect();
    }
    if (db?.isInitialized) await db.destroy();
    if (admin?.isInitialized) {
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.destroy();
    }
  });
  beforeEach(async () => {
    vi.restoreAllMocks();
    await db.query(
      'TRUNCATE users, reward_posts, reward_inbox, reward_policies, user_activities, outbox_events RESTART IDENTITY CASCADE',
    );
    await db.query(`INSERT INTO users(id,nickname,status,created_at,updated_at) VALUES(1,'Author','ACTIVE',now(),now()),(2,'Actor','ACTIVE',now(),now()),(3,'Other','ACTIVE',now(),now());
      TRUNCATE badges RESTART IDENTITY CASCADE;
      INSERT INTO badges(code,name,active,created_at) VALUES('TEST_TITLE','Fixture title',true,now())`);
    service = new ActivityService(
      db,
      new RewardEngine(structuredClone(fixture)),
    );
    await redis.del(POST_STREAM, REWARDS_DLQ, 'user:events');
  });
  function worker(target = service) {
    const w = new PostRewardsConsumer(
      new ConfigService({
        redis: { url: redisUrl },
        rewards: { pendingIdleMs: 1, maxAttempts: 2 },
      }),
      target,
    );
    workers.push(w);
    return w;
  }
  async function add(input: ActivityInput) {
    const f = envelope(input);
    return redis.xadd(POST_STREAM, '*', ...Object.entries(f).flat());
  }
  async function count(table: string) {
    return Number((await db.query(`SELECT count(*) FROM ${table}`))[0].count);
  }
  it('records activities without inventing rewards or levels when policy is disabled', async () => {
    service = new ActivityService(db, new RewardEngine(DISABLED_POLICY));
    await service.record(reaction());
    expect(await service.summary('1')).toMatchObject({
      credits: '0',
      growthScore: '0',
      level: null,
      rewardsEnabled: false,
      nextLevelScore: null,
    });
    expect(await count('credit_ledger')).toBe(0);
    expect(
      (await db.query('SELECT eligibility FROM user_activities'))[0]
        .eligibility,
    ).toBe('PENDING_POLICY');
  });
  it('grants credits and a title to the author, never to the reacting user', async () => {
    await service.record(reaction());
    expect(await service.summary('1')).toMatchObject({
      credits: '10',
      growthScore: '10',
      level: 1,
      nextLevelScore: '20',
    });
    expect((await service.summary('2')).credits).toBe('0');
    expect(await count('user_badges')).toBe(1);
    const users = new UsersService(db.getRepository(UserEntity), {} as never);
    expect((await users.getBadges('1')).badges[0]?.code).toBe('TEST_TITLE');
    expect(await service.reconcile('1')).toMatchObject({
      consistent: true,
      ledgerCredits: '10',
    });
  });
  it('does not reward self reactions', async () => {
    await service.record(reaction(post(), '1'));
    expect(await count('credit_ledger')).toBe(0);
  });
  it.each(['POST', 'COMMENT', 'PARTICIPATION'] as const)(
    'records %s activity without paying',
    async (kind) => {
      const a = { ...reaction(), kind };
      await service.record(a);
      expect(await count('credit_ledger')).toBe(0);
      expect(await service.activityCounts('2')).toEqual([
        { kind, total: '1', active: '1' },
      ]);
    },
  );
  it('ignores unapproved reaction types in an otherwise enabled fixture', async () => {
    await service.record({ ...reaction(), reactionType: 'ENDED' });
    expect(await count('credit_ledger')).toBe(0);
  });
  it('deduplicates simultaneous redelivery by event ID', async () => {
    const a = reaction();
    await Promise.all(Array.from({ length: 8 }, () => service.record(a)));
    expect(await count('reward_inbox')).toBe(1);
    expect(await count('credit_ledger')).toBe(1);
  });
  it('prevents lost updates across posts and duplicate badge grants', async () => {
    await Promise.all(
      Array.from({ length: 8 }, () => service.record(reaction())),
    );
    expect((await service.summary('1')).credits).toBe('80');
    expect(await count('user_badge_history')).toBe(1);
  });
  it('keeps balances exact beyond the JavaScript safe integer range', async () => {
    service = new ActivityService(
      db,
      new RewardEngine({
        ...fixture,
        postReactions: { HELPFUL: Number.MAX_SAFE_INTEGER },
      }),
    );
    await service.record(reaction());
    await service.record(reaction());
    expect((await service.summary('1')).credits).toBe('18014398509481982');
    expect(await service.reconcile('1')).toMatchObject({ consistent: true });
  });
  it('ignores older create after removal and tracks the highest activity version', async () => {
    const a = reaction();
    await service.record({ ...a, eventId: event(), version: 2, active: false });
    await service.record(a);
    expect(await count('credit_ledger')).toBe(0);
    expect(
      (await db.query('SELECT version,active FROM user_activities'))[0],
    ).toMatchObject({ version: '2', active: false });
  });
  it('reverses a grant once, updates levels and revokes the fixture title', async () => {
    const a = reaction();
    await service.record(a);
    const removal = { ...a, eventId: event(), version: 2, active: false };
    await service.record(removal);
    await service.record(removal);
    await service.record(a);
    expect(await service.summary('1')).toMatchObject({
      credits: '0',
      growthScore: '0',
      level: 0,
    });
    expect(await count('credit_ledger')).toBe(2);
    expect(await count('user_badge_history')).toBe(2);
    const types = (await db.query('SELECT event_type FROM outbox_events')).map(
      (r: { event_type: string }) => r.event_type,
    );
    expect(types).toContain('USER_BADGE_REVOKED');
    expect(await service.reconcile('1')).toMatchObject({ consistent: true });
  });
  it('preserves rewards when the injected policy does not revoke removals', async () => {
    service = new ActivityService(
      db,
      new RewardEngine({ ...fixture, revokeOnRemoval: false }),
    );
    const a = reaction();
    await service.record(a);
    await service.record({ ...a, eventId: event(), version: 2, active: false });
    expect((await service.summary('1')).credits).toBe('10');
  });
  it('produces the same kept entitlement for reversed removal delivery', async () => {
    service = new ActivityService(
      db,
      new RewardEngine({ ...fixture, revokeOnRemoval: false }),
    );
    const a = reaction();
    await service.record({ ...a, eventId: event(), version: 2, active: false });
    await service.record(a);
    expect((await service.summary('1')).credits).toBe('10');
    expect(await count('credit_ledger')).toBe(1);
  });
  it('produces the same kept entitlement for a reaction received after expiry', async () => {
    service = new ActivityService(
      db,
      new RewardEngine({ ...fixture, revokeOnExpiry: false }),
    );
    const a = reaction();
    await service.record({
      ...a,
      eventId: event(),
      key: a.postId,
      kind: 'POST',
      actorId: '1',
      version: 2,
      active: false,
      postStatus: 'EXPIRED',
    });
    await service.record(a);
    expect((await service.summary('1')).credits).toBe('10');
  });
  it('rejects conflicting identity and version without committing its receipt', async () => {
    const a = reaction();
    await service.record(a);
    await expect(
      service.record({ ...a, eventId: event(), active: false }),
    ).rejects.toThrow('Conflicting');
    await expect(
      service.record({
        ...a,
        eventId: event(),
        version: 2,
        beneficiaryId: '3',
      }),
    ).rejects.toThrow('Conflicting');
    expect(await count('reward_inbox')).toBe(1);
  });
  it.each(['DELETED', 'EXPIRED'] as const)(
    'blocks late rewards after terminal post state %s',
    async (status) => {
      const a = reaction();
      await service.record({
        ...a,
        eventId: event(),
        key: a.postId,
        kind: 'POST',
        actorId: '1',
        postStatus: status,
        version: 2,
        active: false,
      });
      await service.record(a);
      await service.record({
        ...a,
        key: a.postId,
        kind: 'POST',
        actorId: '1',
        postStatus: 'ACTIVE',
        version: 1,
        eventId: event(),
      });
      expect(await count('credit_ledger')).toBe(0);
    },
  );
  it('reverses all affected rewards on a post deletion without child deletion events', async () => {
    const a = reaction(),
      b = reaction(a.postId, '3');
    await service.record(a);
    await service.record(b);
    await service.record({
      ...a,
      eventId: event(),
      key: a.postId,
      kind: 'POST',
      actorId: '1',
      active: false,
      postStatus: 'DELETED',
      version: 2,
    });
    expect((await service.summary('1')).credits).toBe('0');
    expect(await count('credit_ledger')).toBe(4);
  });
  it('rolls back receipt, state, ledger and balance if outbox insertion fails', async () => {
    await db.query(
      "ALTER TABLE outbox_events ADD CONSTRAINT reject_reward CHECK(event_type <> 'USER_CREDIT_CHANGED')",
    );
    const a = reaction();
    try {
      await expect(service.record(a)).rejects.toThrow();
    } finally {
      await db.query('ALTER TABLE outbox_events DROP CONSTRAINT reject_reward');
    }
    expect(await count('reward_inbox')).toBe(0);
    expect(await count('user_activities')).toBe(0);
    expect(await count('credit_ledger')).toBe(0);
    await service.record(a);
    expect((await service.summary('1')).credits).toBe('10');
  });
  it('holds non-active beneficiaries without defining a sanction policy', async () => {
    await db.query("UPDATE users SET status='SUSPENDED' WHERE id=1");
    await service.record(reaction());
    expect(await count('credit_ledger')).toBe(0);
    expect(
      (await db.query('SELECT eligibility FROM user_activities'))[0]
        .eligibility,
    ).toBe('PENDING_ACCOUNT');
  });
  it('rejects reuse of an immutable policy version', async () => {
    await service.record(reaction());
    const other = new ActivityService(
      db,
      new RewardEngine({ ...fixture, voteWinner: 99 }),
    );
    await expect(other.record(reaction())).rejects.toThrow(
      'version was reused',
    );
    expect(await count('credit_ledger')).toBe(1);
  });
  it('detects a missing balance row rather than reporting a false reconciliation success', async () => {
    await service.record(reaction());
    await db.query('DELETE FROM user_growth WHERE user_id=1');
    expect(await service.reconcile('1')).toMatchObject({
      consistent: false,
      credits: '0',
      ledgerCredits: '10',
    });
  });
  it('keeps pending deliveries if the DLQ write fails', async () => {
    const w = worker();
    await redis.xadd(POST_STREAM, '*', 'data', 'invalid');
    const failed = vi
      .spyOn(w.redis, 'eval')
      .mockRejectedValueOnce(new Error('DLQ unavailable'));
    await expect(w.pollOnce()).rejects.toThrow('DLQ unavailable');
    failed.mockRestore();
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    await worker().pollOnce();
    expect(await redis.xlen(REWARDS_DLQ)).toBe(1);
  });
  it('supports future comment reactions and vote wins with idempotent fixture inputs', async () => {
    const base = {
      eventId: event(),
      correlationId: 'future',
      postId: post(),
      commentId: `comment_${randomUUID()}`,
      actorId: 2,
      beneficiaryId: 1,
      version: 1,
      active: true,
    };
    const comment = parseFutureRewardInput({
      ...base,
      kind: 'COMMENT_REACTION',
      reactionType: 'HELPFUL',
    });
    await service.record(comment);
    await service.record({ ...comment, eventId: event() });
    const vote = parseFutureRewardInput({
      ...base,
      eventId: event(),
      kind: 'VOTE_WIN',
      resultId: 'round-1',
    });
    await service.record(vote);
    await service.record({ ...vote, eventId: event() });
    expect((await service.summary('1')).credits).toBe('25');
  });
  it('exposes trusted-user API, validates limits/cursors and paginates without duplicates', async () => {
    await service.record(reaction());
    await service.record(reaction());
    await request(app.getHttpServer())
      .get('/api/v1/users/me/credits')
      .expect(401);
    await request(app.getHttpServer())
      .get('/api/v1/users/me/credits')
      .set('x-user-id', '999')
      .expect(404);
    await request(app.getHttpServer())
      .get('/api/v1/users/me/growth')
      .set('x-user-id', '1')
      .expect(200)
      .expect((r) => expect(r.body.level).toBe(2));
    for (const query of [
      'limit=0',
      'limit=101',
      'limit=1.5',
      'before=-1',
      'before=9223372036854775808',
      'limit=1&limit=2',
    ])
      await request(app.getHttpServer())
        .get(`/api/v1/users/me/credits/history?${query}`)
        .set('x-user-id', '1')
        .expect(400);
    const first = await request(app.getHttpServer())
      .get('/api/v1/users/me/credits/history?limit=1')
      .set('x-user-id', '1')
      .expect(200);
    const second = await request(app.getHttpServer())
      .get(
        `/api/v1/users/me/credits/history?limit=1&before=${first.body.nextCursor}`,
      )
      .set('x-user-id', '1')
      .expect(200);
    expect(first.body.items[0].id).not.toBe(second.body.items[0].id);
    expect(second.body.nextCursor).toBeNull();
  });
  it('consumes real stream deliveries and ACKs only after DB commit', async () => {
    const w = worker();
    await add(reaction());
    await w.pollOnce();
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(0);
    expect(await count('credit_ledger')).toBe(1);
  });
  it('recovers pending deliveries with a new consumer after worker restart', async () => {
    await redis.xgroup('CREATE', POST_STREAM, REWARDS_GROUP, '0', 'MKSTREAM');
    await add(reaction());
    await redis.xreadgroup(
      'GROUP',
      REWARDS_GROUP,
      'crashed',
      'STREAMS',
      POST_STREAM,
      '>',
    );
    await new Promise((r) => setTimeout(r, 10));
    await worker().pollOnce();
    expect(await count('credit_ledger')).toBe(1);
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(0);
  });
  it('handles two workers consuming concurrently without duplicate grants', async () => {
    const a = reaction();
    for (let i = 0; i < 8; i++) await add(a);
    await Promise.all([worker().pollOnce(), worker().pollOnce()]);
    expect(await count('credit_ledger')).toBe(1);
  });
  it('quarantines malformed data atomically and preserves the raw payload', async () => {
    await redis.xadd(
      POST_STREAM,
      '*',
      'eventId',
      'bad',
      'eventType',
      'PostReactionCreated',
      'data',
      '{',
    );
    await worker().pollOnce();
    expect(await redis.xlen(REWARDS_DLQ)).toBe(1);
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(0);
    expect(await count('reward_inbox')).toBe(0);
  });
  it('leaves DB failures pending, then moves exhausted retries to DLQ', async () => {
    const fake = {
      record: vi.fn().mockRejectedValue(new Error('DB unavailable')),
    } as unknown as ActivityService;
    const w = worker(fake);
    await add(reaction());
    await w.pollOnce();
    expect(await redis.xlen(REWARDS_DLQ)).toBe(0);
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(1);
    await new Promise((r) => setTimeout(r, 10));
    await w.pollOnce();
    expect(await redis.xlen(REWARDS_DLQ)).toBe(1);
  });
  it('redelivers a committed transaction after an ACK failure without paying again', async () => {
    const w = worker();
    await add(reaction());
    const ack = vi
      .spyOn(w.redis, 'xack')
      .mockRejectedValueOnce(new Error('ACK lost'));
    await expect(w.pollOnce()).rejects.toThrow('ACK lost');
    ack.mockRestore();
    await new Promise((r) => setTimeout(r, 10));
    await worker().pollOnce();
    expect(await count('credit_ledger')).toBe(1);
    expect(await count('reward_inbox')).toBe(1);
  });
  it('does not ACK a transaction whose deferred commit fails, then recovers it', async () => {
    await db.query(`CREATE FUNCTION reject_reward_commit() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN RAISE EXCEPTION 'Injected reward commit failure'; END $$;
      CREATE CONSTRAINT TRIGGER reject_reward_commit AFTER INSERT ON reward_inbox
      DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION reject_reward_commit()`);
    const w = worker();
    await add(reaction());
    try {
      await w.pollOnce();
      expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(1);
      expect(await count('credit_ledger')).toBe(0);
      expect(await count('reward_inbox')).toBe(0);
    } finally {
      await db.query(
        'DROP TRIGGER reject_reward_commit ON reward_inbox; DROP FUNCTION reject_reward_commit()',
      );
    }
    await new Promise((r) => setTimeout(r, 10));
    await worker().pollOnce();
    expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))?.[0]).toBe(0);
    expect((await service.summary('1')).credits).toBe('10');
  });
  it('reconnects an ended Redis connection on a later poll', async () => {
    const w = worker();
    await w.pollOnce();
    await new Promise<void>((resolve) => {
      w.redis.once('end', resolve);
      w.redis.disconnect();
    });
    await add(reaction());
    await w.pollOnce();
    expect(await count('credit_ledger')).toBe(1);
  });
  it('publishes compatible growth envelopes through the existing outbox worker', async () => {
    await service.record(reaction());
    const config = new ConfigService({
      redis: { url: redisUrl },
      outbox: { redisTimeoutMs: 2000, pollIntervalMs: 1000, batchSize: 20 },
    });
    const publisher = new RedisStreamsPublisher(config),
      outbox = new OutboxWorker(db, publisher, config);
    try {
      await outbox.publishPending();
      const messages = await redis.xrange('user:events', '-', '+');
      expect(messages).toHaveLength(3);
      for (const [, fields] of messages) {
        const values = Object.fromEntries(
          Array.from({ length: fields.length / 2 }, (_, i) => [
            fields[i * 2],
            fields[i * 2 + 1],
          ]),
        );
        const e = JSON.parse(values.data!);
        expect(e.eventId).toBe(values.eventId);
        expect(e.type).toBe(values.eventType);
        expect(e.payload.userId).toBe('1');
        expect(e.correlationId).toBe('test-request');
      }
    } finally {
      await outbox.onModuleDestroy();
    }
  });
  it('applies and reverts the new migration without changing base user tables', async () => {
    const runner = db.createQueryRunner();
    await runner.connect();
    try {
      await runner.startTransaction();
      const migration = new AddActivityRewards1792190000000();
      await migration.down(runner);
      await migration.up(runner);
      await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
    expect(await count('users')).toBe(3);
  });
});
