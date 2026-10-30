import { ActivateWgoTitles1793400000000 } from '../src/database/migrations/1793400000000-ActivateWgoTitles.js';
import { APP_GUARD } from '@nestjs/core';
import { GatewayAuthGuard } from '../src/http-auth/gateway-auth.guard.js';
import { configureSwagger } from '../src/swagger.js';
import { SignJWT } from 'jose';
import { seedBadgeCatalog } from '../src/rewards/badge-catalog.js';
import { RewardMaintenanceWorker } from '../src/rewards/reward-maintenance.worker.js';
import { parsePostEvent } from '../src/rewards/post-event.js';
import { execFileSync } from 'node:child_process';
import { CompleteActivityRewards1793360000000 } from '../src/database/migrations/1793360000000-CompleteActivityRewards.js';
import 'reflect-metadata';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DataSource } from 'typeorm';
import { Redis } from 'ioredis';
import { randomUUID, generateKeyPairSync } from 'node:crypto';
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
        CompleteActivityRewards1793360000000,
        ActivateWgoTitles1793400000000,
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
            badgeHistory: (id: string, limit: number, before: string | null) =>
              service.badgeHistory(id, limit, before),
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
    await db.transaction(seedBadgeCatalog);
    await db.query('TRUNCATE reward_post_regions,reward_post_region_history');
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
      await new ActivateWgoTitles1793400000000().down(runner);
      await new CompleteActivityRewards1793360000000().down(runner);
      await migration.down(runner);
      await migration.up(runner);
      await new CompleteActivityRewards1793360000000().up(runner);
      await new ActivateWgoTitles1793400000000().up(runner);
      await runner.rollbackTransaction();
    } finally {
      await runner.release();
    }
    expect(await count('users')).toBe(3);
  });
  // Wire fixtures follow PR #72 at 70f35ac2; they do not run the Post process.
  function wire(
    type: string,
    p = post(),
    commentId = `comment_${randomUUID()}`,
    patch: Record<string, unknown> = {},
  ) {
    const now = new Date().toISOString();
    const value = {
      eventId: event(),
      eventType: type,
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: p,
      correlationId: 'pr72',
      occurredAt: now,
      activityVersion: type === 'PostCommentReactionRemoved' ? 2 : 1,
      commentAuthorId: 1,
      postAuthorId: 1,
      postCategory: 'GENERAL',
      postVersion: 2,
      commentReaction: {
        postId: p,
        commentId,
        userId: 2,
        type: 'HELPFUL',
        createdAt: now,
        removedAt: now,
      },
      vote: {
        postId: p,
        resultId: p,
        commentId,
        winnerAuthorId: 1,
        votes: 3,
        closedAt: now,
      },
      comment: {
        postId: p,
        commentId,
        authorId: 1,
        content: 'Contract fixture',
        status: 'ACTIVE',
        updatedAt: null,
        createdAt: now,
        deletedAt: now,
      },
      reaction: {
        postId: p,
        userId: 2,
        type: 'HELPFUL',
        createdAt: now,
        removedAt: now,
      },
      participant: {
        postId: p,
        userId: 2,
        joinedAt: now,
        lastSeenAt: now,
        leftAt: type === 'PostParticipantJoined' ? null : now,
      },
      post: {
        postId: p,
        authorId: 1,
        category: 'GENERAL',
        closedAt: now,
        latitude: 0,
        longitude: 0,
        radiusM: 10,
        expiresAt: now,
        deletedAt: now,
        expiredAt: now,
      },
      actor: { type: 'USER', userId: 1 },
      reason: 'USER_REQUEST',
      ...patch,
    };
    return {
      eventId: value.eventId,
      eventType: type,
      data: JSON.stringify(value),
    };
  }
  async function send(f: ReturnType<typeof wire>) {
    await redis.xadd(POST_STREAM, '*', ...Object.entries(f).flat());
    await worker().pollOnce();
  }
  function decode(fields: string[]) {
    return JSON.parse(
      Object.fromEntries(
        Array.from({ length: fields.length / 2 }, (_, i) => [
          fields[i * 2],
          fields[i * 2 + 1],
        ]),
      ).data!,
    );
  }

  it.each([
    'PostCreated',
    'PostDeleted',
    'PostExpired',
    'PostCommentCreated',
    'PostCommentDeleted',
    'PostReactionCreated',
    'PostReactionRemoved',
    'PostParticipantJoined',
    'PostParticipantLeft',
  ])('consumes legacy %s through Redis without quarantine', async (type) => {
    await send(wire(type));
    expect(await count('reward_inbox')).toBe(1);
    expect(await redis.xlen(REWARDS_DLQ)).toBe(0);
  });
  it('recovers an exhausted DB delivery from DLQ using the same original event ID', async () => {
    const f = wire('PostVoteWon'),
      w = worker({
        record: async () => {
          throw new Error('DB offline');
        },
      } as unknown as ActivityService);
    await redis.xadd(POST_STREAM, '*', ...Object.entries(f).flat());
    await w.pollOnce();
    await new Promise((r) => setTimeout(r, 10));
    await w.pollOnce();
    expect(await redis.xlen(REWARDS_DLQ)).toBe(1);
    expect(await count('reward_inbox')).toBe(0);
    const fields = (await redis.xrange(REWARDS_DLQ, '-', '+'))[0]![1];
    const raw = Object.fromEntries(
      Array.from({ length: fields.length / 2 }, (_, i) => [
        fields[i * 2],
        fields[i * 2 + 1],
      ]),
    );
    const value = JSON.parse(raw.data!);
    await send({
      eventId: value.eventId,
      eventType: value.eventType,
      data: raw.data!,
    });
    await send(f);
    await send(f);
    expect(await count('credit_ledger')).toBe(1);
  });
  it('consumes PR72 comment create/remove/recreate and deduplicates both event and relation versions', async () => {
    const f = wire('PostCommentReactionCreated');
    const v = JSON.parse(f.data);
    await send(f);
    await send(f);
    expect((await service.summary('1')).credits).toBe('5');
    expect((await service.summary('2')).credits).toBe('0');
    await send(
      wire(
        'PostCommentReactionRemoved',
        v.aggregateId,
        v.commentReaction.commentId,
      ),
    );
    await send(
      wire(
        'PostCommentReactionCreated',
        v.aggregateId,
        v.commentReaction.commentId,
        { activityVersion: 3 },
      ),
    );
    await send(f);
    expect((await service.summary('1')).credits).toBe('5');
    expect(await count('credit_ledger')).toBe(3);
    expect(
      (await db.query('SELECT comment_id,version FROM user_activities'))[0],
    ).toMatchObject({ comment_id: v.commentReaction.commentId, version: '3' });
  });
  it('keeps a newer PR72 cancellation when its create arrives late', async () => {
    const p = post(),
      c = `comment_${randomUUID()}`;
    await send(wire('PostCommentReactionRemoved', p, c));
    await send(wire('PostCommentReactionCreated', p, c));
    expect(await count('credit_ledger')).toBe(0);
  });
  it.each(['self', 'DIFFERENT'])(
    'does not pay PR72 %s comment reactions',
    async (kind) => {
      const f = wire('PostCommentReactionCreated'),
        v = JSON.parse(f.data);
      v.commentReaction[kind === 'self' ? 'userId' : 'type'] =
        kind === 'self' ? 1 : 'DIFFERENT';
      await send({ ...f, data: JSON.stringify(v) });
      expect(await count('credit_ledger')).toBe(0);
    },
  );
  it.each(['before', 'after'])(
    'links deleted comments to reactions and vote wins received %s deletion',
    async (order) => {
      const p = post(),
        c = `comment_${randomUUID()}`;
      const child = async () => {
        await send(wire('PostCommentReactionCreated', p, c));
        await send(wire('PostVoteWon', p, c));
      };
      if (order === 'before') await child();
      await send(wire('PostCommentDeleted', p, c, { activityVersion: 2 }));
      if (order === 'after') await child();
      expect((await service.summary('1')).credits).toBe('0');
      expect(
        (
          await db.query(
            "SELECT count(*) FROM user_activities WHERE kind IN ('COMMENT_REACTION','VOTE_WIN') AND comment_id=$1",
            [c],
          )
        )[0].count,
      ).toBe('2');
    },
  );

  it('fills migrated vote comment context at the same version without paying twice', async () => {
    const f = wire('PostVoteWon'),
      v = JSON.parse(f.data);
    await send(f);
    await db.query('UPDATE user_activities SET comment_id=NULL');
    await send(wire('PostVoteWon', v.aggregateId, v.vote.commentId));
    expect(await count('credit_ledger')).toBe(1);
    expect(
      (await db.query('SELECT comment_id FROM user_activities'))[0].comment_id,
    ).toBe(v.vote.commentId);
    await send(
      wire('PostCommentDeleted', v.aggregateId, v.vote.commentId, {
        activityVersion: 2,
      }),
    );
    expect((await service.summary('1')).credits).toBe('0');
  });
  it('keeps only the deterministic top title holder under concurrent grants', async () => {
    await db.query(
      "INSERT INTO badges(code,name,active,created_at) VALUES('TEST_RANK','Rank fixture',true,now())",
    );
    service = new ActivityService(
      db,
      new RewardEngine({
        ...fixture,
        badges: [
          {
            code: 'TEST_RANK',
            minimumScore: 1,
            rankTop: 1,
            revokeBelow: true,
          },
        ],
      }),
    );
    await Promise.all([
      service.record(reaction()),
      service.record({ ...reaction(), beneficiaryId: '3' }),
    ]);
    const rows = await db.query(
      'SELECT user_id FROM user_badges WHERE revoked_at IS NULL',
    );
    expect(rows).toEqual([{ user_id: '1' }]);
  });
  it('uses one result key and quarantines a conflicting PR72 winner', async () => {
    const f = wire('PostVoteWon'),
      v = JSON.parse(f.data);
    await send(f);
    await send(wire('PostVoteWon', v.aggregateId, v.vote.commentId));
    await send(
      wire('PostVoteWon', v.aggregateId, v.vote.commentId, {
        vote: { ...v.vote, winnerAuthorId: 3 },
      }),
    );
    expect((await service.summary('1')).credits).toBe('20');
    expect((await service.summary('3')).credits).toBe('0');
    expect(await count('credit_ledger')).toBe(1);
    expect(await redis.xlen(REWARDS_DLQ)).toBe(1);
  });
  it.each(['DELETED', 'EXPIRED'] as const)(
    'does not grant a late vote after post %s',
    async (status) => {
      const f = wire('PostVoteWon');
      const { resultId: _resultId, ...a } = parsePostEvent(f)!;
      await service.record({
        ...a,
        eventId: event(),
        key: a.postId,
        kind: 'POST',
        postStatus: status,
        active: false,
        version: 2,
      });
      await send(f);
      expect(await count('credit_ledger')).toBe(0);
    },
  );
  it('ACKs PostUpdated without changing rewards and distinguishes unsupported from invalid', async () => {
    await send(wire('PostUpdated'));
    expect(await count('reward_inbox')).toBe(0);
    expect(await redis.xlen(REWARDS_DLQ)).toBe(0);
    await send(wire('FuturePostMetric'));
    await send(
      wire('PostVoteWon', post(), `comment_${randomUUID()}`, {
        activityVersion: 2,
      }),
    );
    const reasons = (await redis.xrange(REWARDS_DLQ, '-', '+')).map(
      ([, f]) =>
        Object.fromEntries(
          Array.from({ length: f.length / 2 }, (_, i) => [
            f[i * 2],
            f[i * 2 + 1],
          ]),
        ).reason,
    );
    expect(reasons).toEqual(['UNSUPPORTED_EVENT', 'INVALID_EVENT']);
  });
  it('enforces gross daily caps across simultaneous posts and does not refund revoked budget', async () => {
    service = new ActivityService(
      db,
      new RewardEngine({
        ...fixture,
        dailyCreditLimit: 20,
        dayTimeZone: 'Asia/Seoul',
      }),
    );
    const inputs = Array.from({ length: 8 }, () => reaction());
    await Promise.all(inputs.map((a) => service.record(a)));
    expect((await service.summary('1')).credits).toBe('20');
    for (const a of inputs)
      await service.record({
        ...a,
        eventId: event(),
        version: 2,
        active: false,
      });
    await service.record({
      ...reaction(),
      occurredAt: '2000-01-01T00:00:00.000Z',
    });
    expect((await service.summary('1')).credits).toBe('0');
    expect(
      (await db.query('SELECT credits_granted FROM reward_daily_usage'))[0]
        .credits_granted,
    ).toBe('20');
  });
  it('limits repeated regrants by stable activity identity', async () => {
    service = new ActivityService(
      db,
      new RewardEngine({ ...fixture, maxGrantsPerActivity: 2 }),
    );
    const a = reaction();
    for (let version = 1; version <= 5; version++)
      await service.record({
        ...a,
        eventId: event(),
        version,
        active: version % 2 === 1,
      });
    expect((await service.summary('1')).credits).toBe('0');
    expect(
      (await db.query('SELECT grants FROM reward_entitlements'))[0].grants,
    ).toBe(2);
    expect(await count('credit_ledger')).toBe(4);
  });
  it('keeps original grant amount and revocation rules across policy versions', async () => {
    const a = reaction();
    await service.record(a);
    service = new ActivityService(
      db,
      new RewardEngine({
        ...fixture,
        version: 'fixture-v2',
        postReactions: { HELPFUL: 99 },
        revokeOnRemoval: false,
      }),
    );
    await service.record({ ...a, eventId: event(), version: 2, active: false });
    expect((await service.summary('1')).credits).toBe('0');
    await service.record({ ...a, eventId: event(), version: 3, active: true });
    expect((await service.summary('1')).credits).toBe('10');
  });

  it('honors explicit title retention during sanctions even when threshold revocation is enabled', async () => {
    const engine = new RewardEngine({ ...fixture, revokeOnSanction: false });
    service = new ActivityService(db, engine);
    await service.record(reaction());
    await db.query("UPDATE users SET status='SUSPENDED' WHERE id=1");
    await new RewardMaintenanceWorker(db, service, engine).run();
    expect((await service.summary('1')).credits).toBe('10');
    expect(
      (await db.query('SELECT revoked_at FROM user_badges'))[0].revoked_at,
    ).toBeNull();
    expect(await count('user_badge_history')).toBe(1);
  });
  it('reconciles held, sanctioned and restored accounts without duplicate ledger entries', async () => {
    const engine = new RewardEngine({ ...fixture, revokeOnSanction: true }),
      activities = new ActivityService(db, engine);
    service = activities;
    await db.query("UPDATE users SET status='SUSPENDED' WHERE id=1");
    await service.record(reaction());
    expect(await count('credit_ledger')).toBe(0);
    const maintain = () =>
      new RewardMaintenanceWorker(db, activities, engine).run();
    await db.query("UPDATE users SET status='ACTIVE' WHERE id=1");
    await maintain();
    expect((await service.summary('1')).credits).toBe('10');
    await maintain();
    expect(await count('credit_ledger')).toBe(1);
    await db.query("UPDATE users SET status='SUSPENDED' WHERE id=1");
    await maintain();
    expect((await service.summary('1')).credits).toBe('0');
    await db.query("UPDATE users SET status='ACTIVE' WHERE id=1");
    await maintain();
    expect((await service.summary('1')).credits).toBe('10');
  });
  it('reconciles policy-only level changes and reusing an operation is harmless', async () => {
    await service.record(reaction());
    service = new ActivityService(
      db,
      new RewardEngine({ ...fixture, version: 'new-levels', levels: [0, 100] }),
    );
    await service.reconcileUser('1', 'policy-change');
    await service.reconcileUser('1', 'policy-change');
    expect((await db.query('SELECT level FROM user_growth'))[0].level).toBe(0);
    expect(await count('credit_ledger')).toBe(1);
    const events = await db.query(
      "SELECT payload FROM outbox_events WHERE event_type='USER_LEVEL_CHANGED' ORDER BY created_at DESC",
    );
    expect(events[0].payload.payload.changeType).toBe('DOWN');
  });
  it('preserves catalog seed and generic legacy fixture badge rules', async () => {
    await db.transaction(seedBadgeCatalog);
    await db.query("UPDATE badges SET name='Custom' WHERE code='NEWS_SOURCE'");
    await db.transaction(seedBadgeCatalog);
    expect(await count('badges')).toBe(5);
    expect(
      (await db.query("SELECT name FROM badges WHERE code='NEWS_SOURCE'"))[0]
        .name,
    ).toBe('Custom');
    await db.query(
      "INSERT INTO badges(code,name,active,created_at) SELECT code,code,true,now() FROM unnest(ARRAY['TEST_NEWS','TEST_REPORTER','TEST_CORRESPONDENT','TEST_CLAIRVOYANT']) AS code",
    );
    const engine = new RewardEngine({
      ...fixture,
      badges: [
        {
          code: 'TEST_NEWS',
          minimumScore: 0,
          minimumParticipation: 1,
          revokeBelow: true,
        },
        {
          code: 'TEST_REPORTER',
          minimumScore: 5,
          minimumPositiveReactions: 1,
          revokeBelow: true,
        },
        {
          code: 'TEST_CORRESPONDENT',
          minimumScore: 20,
          minimumVoteWins: 1,
          revokeBelow: true,
        },
        {
          code: 'TEST_CLAIRVOYANT',
          minimumScore: 1,
          rankTop: 1,
          revokeBelow: true,
        },
      ],
    });
    service = new ActivityService(db, engine);
    await service.record({
      ...reaction(),
      kind: 'PARTICIPATION',
      actorId: '1',
      beneficiaryId: null,
    });
    const f = wire('PostVoteWon');
    await send(f);
    await service.record(reaction());
    const granted = () =>
      db.query(
        'SELECT b.code FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE user_id=1 AND revoked_at IS NULL ORDER BY code',
      );
    expect((await granted()).map((r: { code: string }) => r.code)).toHaveLength(
      4,
    );
    await db.transaction(seedBadgeCatalog);
    expect((await granted()).length).toBe(4);
    for (let i = 0; i < 4; i++)
      await service.record({ ...reaction(), beneficiaryId: '3' });
    await service.refreshUserTitles('1');
    expect(
      (await granted()).map((r: { code: string }) => r.code),
    ).not.toContain('TEST_CLAIRVOYANT');
    await request(app.getHttpServer())
      .get('/api/v1/users/me/badges/history?limit=1')
      .set('x-user-id', '1')
      .expect(200)
      .expect((r) => expect(r.body.nextCursor).toBeTruthy());
    expect(await service.reconcile('1')).toMatchObject({ consistent: true });
  });
  it('publishes all four User types and retains pending outbox rows when Redis fails', async () => {
    const a = reaction();
    await service.record(a);
    await service.record({ ...a, eventId: event(), version: 2, active: false });
    const config = new ConfigService({
      redis: { url: redisUrl },
      outbox: { redisTimeoutMs: 2000, pollIntervalMs: 1000, batchSize: 30 },
    });
    const publisher = new RedisStreamsPublisher(config),
      outbox = new OutboxWorker(db, publisher, config);
    try {
      const fail = vi
        .spyOn(publisher, 'publish')
        .mockRejectedValueOnce(new Error('Redis offline'));
      await outbox.publishPending();
      fail.mockRestore();
      await outbox.publishPending();
      const messages = (await redis.xrange('user:events', '-', '+')).map(
        ([, f]) => decode(f),
      );
      expect(new Set(messages.map((e) => e.type))).toEqual(
        new Set([
          'USER_CREDIT_CHANGED',
          'USER_LEVEL_CHANGED',
          'USER_BADGE_GRANTED',
          'USER_BADGE_REVOKED',
        ]),
      );
      expect(
        (
          await db.query(
            "SELECT count(*) FROM outbox_events WHERE status='PENDING'",
          )
        )[0].count,
      ).toBe('0');
      for (const e of messages)
        expect(e).toMatchObject({
          version: 1,
          producer: 'user-service',
          payload: { userId: '1' },
        });
    } finally {
      await outbox.onModuleDestroy();
    }
  });
  it('backfills legacy ledger without changing users, awards or original grant rules', async () => {
    const a = reaction();
    await service.record(a);
    const runner = db.createQueryRunner();
    await runner.connect();
    await runner.startTransaction();
    try {
      const before = await runner.query(
        'SELECT * FROM credit_ledger ORDER BY id',
      );
      const migration = new CompleteActivityRewards1793360000000();
      await new ActivateWgoTitles1793400000000().down(runner);
      await migration.down(runner);
      await migration.up(runner);
      await new ActivateWgoTitles1793400000000().up(runner);
      expect(
        await runner.query('SELECT * FROM credit_ledger ORDER BY id'),
      ).toEqual(before);
      expect(
        (
          await runner.query(
            'SELECT amount,grants,policy_version FROM reward_entitlements',
          )
        )[0],
      ).toMatchObject({
        amount: '10',
        grants: 1,
        policy_version: fixture.version,
      });
      expect(
        (
          await runner.query('SELECT credits_granted FROM reward_daily_usage')
        )[0].credits_granted,
      ).toBe('10');
      expect((await runner.query('SELECT count(*) FROM users'))[0].count).toBe(
        '3',
      );
    } finally {
      await runner.rollbackTransaction();
      await runner.release();
    }
  });
  it.skipIf(!process.env.USER_REWARDS_RESTART_CONTAINER)(
    'recovers persisted pending entries after a real Redis restart',
    async () => {
      const container = process.env.USER_REWARDS_RESTART_CONTAINER!;
      if (
        !/^(wgo-user-rewards-redis-final-\d+|wgo-user-title-policy-redis-\d+)$/.test(
          container,
        )
      )
        throw new Error('Unexpected restart target');
      const inspected = JSON.parse(
        execFileSync('docker', ['inspect', container], { encoding: 'utf8' }),
      )[0];
      expect(
        inspected.Config.Labels[
          container.startsWith('wgo-user-title-policy-')
            ? 'com.wgo.user-title-policy-test'
            : 'com.wgo.user-rewards-test'
        ],
      ).toBe('1');
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
      execFileSync('docker', ['restart', container], { stdio: 'pipe' });
      await redis.ping();
      await worker().pollOnce();
      expect((await service.summary('1')).credits).toBe('10');
      expect((await redis.xpending(POST_STREAM, REWARDS_GROUP))[0]).toBe(0);
    },
    30000,
  );
  it.runIf(process.env.RUN_REWARDS_GATEWAY_INTEGRATION === '1')(
    'serves real rewards through Gateway ES256 and merges their actual OpenAPI schemas',
    async () => {
      const { privateKey, publicKey } = generateKeyPairSync('ec', {
        namedCurve: 'P-256',
      });
      const previous = process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
      process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = JSON.stringify({
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            alg: 'ES256',
            kid: 'rewards-test',
            iss: 'wgo-http-gateway',
          },
        ],
      });
      let guarded: INestApplication | undefined;
      let gateway: { close(): Promise<void> } | undefined;
      try {
        await service.record(reaction());
        const module = await Test.createTestingModule({
          controllers: [RewardsController],
          providers: [
            { provide: ActivityService, useValue: service },
            { provide: APP_GUARD, useClass: GatewayAuthGuard },
          ],
        }).compile();
        guarded = module.createNestApplication();
        configureSwagger(guarded);
        await guarded.listen(0, '127.0.0.1');
        const userUrl = await guarded.getUrl();
        const { buildApp } = await import(
          new URL(
            '../../../gateways/http-gateway/dist/src/app.js',
            import.meta.url,
          ).href
        );
        const { loadConfig } = await import(
          new URL(
            '../../../gateways/http-gateway/dist/src/config.js',
            import.meta.url,
          ).href
        );
        const { mergeDocuments } = await import(
          new URL(
            '../../../gateways/http-gateway/dist/src/openapi.js',
            import.meta.url,
          ).href
        );
        const config = loadConfig();
        config.rateLimit.enabled = false;
        config.services.user = userUrl;
        const secret = 'rewards-test-access-secret-at-least-32-bytes';
        config.userAuth = {
          accessSecret: secret,
          issuer: 'wgo-user-test',
          audience: 'wgo-api-test',
          servicePrivateJwk: JSON.stringify({
            ...privateKey.export({ format: 'jwk' }),
            alg: 'ES256',
            kid: 'rewards-test',
          }),
        };
        const running = await buildApp({ config, logger: false });
        gateway = running;
        const token = await new SignJWT({ sid: randomUUID() })
          .setProtectedHeader({ alg: 'HS256', typ: 'JWT' })
          .setSubject('1')
          .setIssuer('wgo-user-test')
          .setAudience('wgo-api-test')
          .setIssuedAt()
          .setExpirationTime('15m')
          .sign(new TextEncoder().encode(secret));
        for (const path of [
          'credits',
          'growth',
          'credits/history',
          'badges/history',
        ]) {
          const url = `/api/v1/users/me/${path}`;
          await request(userUrl).get(url).set('x-user-id', '1').expect(401);
          expect(
            (
              await running.inject({
                method: 'GET',
                url,
                headers: { 'x-user-id': '1' },
              })
            ).statusCode,
          ).toBe(401);
          const result = await running.inject({
            method: 'GET',
            url,
            headers: { authorization: `Bearer ${token}`, 'x-user-id': '3' },
          });
          expect(result.statusCode).toBe(200);
          if (path === 'credits' || path === 'growth') {
            expect(result.json().credits).toBe('10');
            expect(result.json().titles).toMatchObject({
              enabled: true,
              policyVersion: 'wgo-titles-v1',
            });
          }
        }
        const { body: document } = await request(userUrl)
          .get('/docs/openapi.json')
          .expect(200);
        const merged = await mergeDocuments(
          [{ service: 'user', document }],
          config,
        );
        for (const path of [
          'credits',
          'growth',
          'credits/history',
          'badges/history',
        ]) {
          const op = merged.paths[`/api/v1/users/me/${path}`].get;
          expect(op.security).toEqual([{ user__UserAccess: [] }]);
          expect(
            op.parameters.some((p: { name: string }) => p.name === 'X-User-Id'),
          ).toBe(false);
          expect(
            op.responses['200'].content['application/json'].schema.$ref,
          ).toMatch(/user__/);
        }
      } finally {
        await gateway?.close();
        await guarded?.close();
        if (previous === undefined)
          delete process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS;
        else process.env.USER_HTTP_GATEWAY_TRUSTED_JWKS = previous;
      }
    },
  );
});
