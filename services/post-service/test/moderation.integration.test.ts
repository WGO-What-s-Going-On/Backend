import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import {
  beforeAll,
  afterAll,
  beforeEach,
  describe,
  it,
  expect,
  vi,
} from 'vitest';
import { AppModule } from '../src/app.module.js';
import { ApplyModerationLifecycle } from '../src/post/application/moderation.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { MongoosePostStore } from '../src/post/infrastructure/mongoose-post.store.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import { VoteWorker } from '../src/post/infrastructure/vote.worker.js';
import {
  ModerationWorker,
  ModerationConsumer,
  MODERATION_STREAM,
  MODERATION_GROUP,
  MODERATION_DEAD_STREAM,
} from '../src/post/infrastructure/moderation-consumer.js';
import { parseModerationEvent } from '../src/post/infrastructure/moderation-event.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('Moderation v1 -> Post transaction -> Outbox', () => {
  let app: INestApplication;
  let db: Connection;
  let posts: Model<any>;
  let outbox: Model<any>;
  let receipts: Model<any>;
  let apply: ApplyModerationLifecycle;
  let consumer: ModerationConsumer;
  const redis = createClient({ url: 'redis://localhost:6380/12' });
  const fields = (postId: string, eventType = 'BOARD_CLOSED') => {
    const eventId = `evt_${randomUUID()}`;
    return {
      eventId,
      eventType,
      data: JSON.stringify({
        eventId,
        eventType,
        aggregateId: postId,
        producer: 'moderation-service',
        schemaVersion: 1,
        correlationId: 'req-moderation-test',
        occurredAt: new Date(Date.now() - 1000).toISOString(),
        payload: {
          postId,
          state: {
            BOARD_STALE: 'STALE',
            BOARD_REACTIVATED: 'ACTIVE',
            BOARD_CLOSED: 'CLOSED',
          }[eventType],
        },
      }),
    };
  };
  const create = async () =>
    (
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set('X-User-Id', '123')
        .send({
          title: 'Lifecycle',
          content: 'Test',
          category: 'INCIDENT',
          latitude: 37.5,
          longitude: 127,
          radiusM: 250,
        })
        .expect(201)
    ).body.postId as string;

  const openWinningVote = async (postId: string) => {
    const commentId = `comment_${randomUUID()}`;
    await db.model('Comment').create({
      postId,
      commentId,
      authorId: 456,
      content: 'Winner',
      status: 'ACTIVE',
      createdAt: new Date(),
    });
    await posts.updateOne(
      { postId },
      {
        $set: {
          vote: {
            status: 'OPEN',
            selectedAt: new Date(),
            closedAt: null,
            winner: null,
            candidates: [
              { commentId, content: 'Winner', scoreAtSelection: 0, votes: 2 },
              {
                commentId: `comment_${randomUUID()}`,
                content: 'Other',
                scoreAtSelection: 0,
                votes: 1,
              },
            ],
          },
        },
      },
    );
    return commentId;
  };

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'MONGODB_URI',
      `mongodb://localhost:27017/moderation_it_${randomUUID().replaceAll('-', '')}?replicaSet=rs0`,
    );
    vi.stubEnv('REDIS_URL', 'redis://localhost:6380/12');
    vi.stubEnv('SEMANTIC_ENABLED', 'false');
    vi.stubEnv('POST_MODERATION_CONSUMER_ENABLED', 'false');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOCATION_AUTHORIZATION)
      .useValue({
        assertCanCreate: async () => {},
        assertCanJoin: async () => {},
      })
      .overrideProvider(OutboxWorker)
      .useValue({ wake() {} })
      .overrideProvider(UserProfiles)
      .useValue({
        names: async (ids: number[]) =>
          new Map(ids.map((id) => [id, `user-${id}`])),
      })
      .compile();
    app = module.createNestApplication();
    await app.init();
    await app.get(ExpirationWorker).onModuleDestroy();
    await app.get(VoteWorker).onModuleDestroy();
    db = app.get(getConnectionToken());
    for (const model of Object.values(db.models)) await model.syncIndexes();
    posts = app.get(getModelToken('Post'));
    outbox = app.get(getModelToken('Outbox'));
    receipts = app.get(getModelToken('ModerationReceipt'));
    apply = app.get(ApplyModerationLifecycle);
    await redis.connect();
  }, 30000);
  beforeEach(async () => {
    await redis.flushDb(); // 이 suite 전용 DB 12만 초기화한다.
    consumer = new ModerationConsumer(redis, apply, 0);
    await consumer.initialize();
  });
  afterAll(async () => {
    await db?.dropDatabase();
    await app?.close();
    if (redis.isOpen) {
      await redis.flushDb();
      await redis.quit();
    }
    vi.unstubAllEnvs();
  });

  it('records STALE and REACTIVATED without changing state or creating expiration', async () => {
    const postId = await create();
    for (const type of ['BOARD_STALE', 'BOARD_REACTIVATED'])
      await redis.xAdd(MODERATION_STREAM, '*', fields(postId, type));
    await consumer.tick();
    expect((await posts.findOne({ postId })).status).toBe('ACTIVE');
    expect(await receipts.countDocuments({ postId })).toBe(2);
    expect(
      await outbox.countDocuments({
        aggregateId: postId,
        eventType: 'PostExpired',
      }),
    ).toBe(0);
  });
  it('commits the winning vote, receipt and expiration once despite concurrent duplicates', async () => {
    const postId = await create();
    const commentId = await openWinningVote(postId);
    const wire = fields(postId);
    const input = parseModerationEvent(wire)!;
    await Promise.all([apply.execute(input), apply.execute(input)]);
    const post = await posts.findOne({ postId });
    expect(post.status).toBe('EXPIRED');
    expect(post.vote.status).toBe('CLOSED');
    expect(post.expiresAt).toEqual(input.occurredAt);
    expect(post.postVersion).toBe(2);
    expect(await receipts.countDocuments({ eventId: input.eventId })).toBe(1);
    const rows = await outbox.find({
      aggregateId: postId,
      eventType: 'PostExpired',
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].correlationId).toBe(input.correlationId);
    expect(rows[0].payload.sourceEventId).toBe(input.eventId);
    const wins = await outbox.find({
      aggregateId: postId,
      eventType: 'PostVoteWon',
    });
    expect(wins).toHaveLength(1);
    expect(wins[0].payload).toMatchObject({
      activityVersion: 1,
      vote: {
        postId,
        resultId: postId,
        commentId,
        winnerAuthorId: 456,
        votes: 2,
      },
    });

    await redis.xAdd(MODERATION_STREAM, '*', wire);
    await consumer.tick();
    expect(
      (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
    ).toBe(0);
    expect(
      await outbox.countDocuments({
        aggregateId: postId,
        eventType: 'PostExpired',
      }),
    ).toBe(1);
    expect(
      await outbox.countDocuments({
        aggregateId: postId,
        eventType: 'PostVoteWon',
      }),
    ).toBe(1);
  });
  it.each(['EXPIRED', 'DELETED'])(
    'does not change terminal %s or resurrect on REACTIVATED',
    async (status) => {
      const postId = await create();
      await posts.updateOne({ postId }, { $set: { status } });
      for (const type of ['BOARD_CLOSED', 'BOARD_REACTIVATED'])
        await redis.xAdd(MODERATION_STREAM, '*', fields(postId, type));
      await consumer.tick();
      expect((await posts.findOne({ postId })).status).toBe(status);
      expect(await receipts.countDocuments({ postId })).toBe(2);
      expect(
        await outbox.countDocuments({
          aggregateId: postId,
          eventType: 'PostExpired',
        }),
      ).toBe(0);
    },
  );
  it.each(['PostVoteWon', 'PostExpired'])(
    'rolls back the winner, receipt and state when %s insertion fails',
    async (failedType) => {
      const postId = await create();
      await openWinningVote(postId);
      const input = parseModerationEvent(fields(postId))!;
      const store = app.get(MongoosePostStore);
      const failing = new ApplyModerationLifecycle({
        execute: (work) =>
          store.execute((tx) =>
            work({
              ...tx,
              commands: new Proxy(tx.commands, {
                get(target, prop) {
                  if (prop === 'appendEvent')
                    return async (
                      row: Parameters<typeof target.appendEvent>[0],
                    ) => {
                      if (row.eventType === failedType)
                        throw new Error('outbox unavailable');
                      await target.appendEvent(row);
                    };
                  const value = Reflect.get(target, prop);
                  return typeof value === 'function'
                    ? value.bind(target)
                    : value;
                },
              }),
            }),
          ),
      });
      await expect(failing.execute(input)).rejects.toThrow(
        'outbox unavailable',
      );
      expect((await posts.findOne({ postId })).status).toBe('ACTIVE');
      expect(await receipts.countDocuments({ eventId: input.eventId })).toBe(0);
      expect((await posts.findOne({ postId })).vote.status).toBe('OPEN');
      expect(
        await outbox.countDocuments({
          aggregateId: postId,
          eventType: { $in: ['PostVoteWon', 'PostExpired'] },
        }),
      ).toBe(0);

      await apply.execute(input);
      expect((await posts.findOne({ postId })).status).toBe('EXPIRED');
      expect(
        await outbox.countDocuments({
          aggregateId: postId,
          eventType: 'PostVoteWon',
        }),
      ).toBe(1);
      expect(
        await outbox.countDocuments({
          aggregateId: postId,
          eventType: 'PostExpired',
        }),
      ).toBe(1);
    },
  );
  it('reclaims a committed delivery left unacknowledged by a crashed consumer', async () => {
    const postId = await create();
    const wire = fields(postId);
    await redis.xAdd(MODERATION_STREAM, '*', wire);
    await redis.xReadGroup(MODERATION_GROUP, 'crashed', {
      key: MODERATION_STREAM,
      id: '>',
    });
    await apply.execute(parseModerationEvent(wire)!); // commit succeeded, process died before ACK
    await consumer.tick();
    expect(
      (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
    ).toBe(0);
    expect(
      await outbox.countDocuments({
        aggregateId: postId,
        eventType: 'PostExpired',
      }),
    ).toBe(1);
  });
  it('starts the configured worker and drains an existing lifecycle event', async () => {
    const postId = await create();
    await redis.xAdd(MODERATION_STREAM, '*', fields(postId));
    vi.stubEnv('POST_MODERATION_CONSUMER_ENABLED', 'true');
    vi.stubEnv('MODERATION_REDIS_URL', 'redis://localhost:6380/12');
    const worker = new ModerationWorker(apply, receipts);
    try {
      worker.onModuleInit();
      await vi.waitFor(
        async () => {
          expect((await posts.findOne({ postId })).status).toBe('EXPIRED');
          expect(
            (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
          ).toBe(0);
        },
        { timeout: 5000 },
      );
    } finally {
      await worker.onModuleDestroy();
      vi.stubEnv('POST_MODERATION_CONSUMER_ENABLED', 'false');
    }
  });
  it('keeps missing targets pending and quarantines only after retry budget', async () => {
    const wire = fields(`post_${randomUUID()}`);
    await redis.xAdd(MODERATION_STREAM, '*', wire);
    await consumer.tick();
    expect(
      (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
    ).toBe(1);
    expect(await receipts.countDocuments({ eventId: wire.eventId })).toBe(0);
    for (let i = 0; i < 4; i++) await consumer.tick();
    expect(
      (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
    ).toBe(0);
    expect(await redis.xLen(MODERATION_DEAD_STREAM)).toBe(1);
  });
  it('does not ACK malformed input until DLQ persistence succeeds', async () => {
    await redis.set(MODERATION_DEAD_STREAM, 'wrong-type');
    await redis.xAdd(MODERATION_STREAM, '*', {
      eventType: 'BOARD_CLOSED',
      data: '{}',
    });
    await expect(consumer.tick()).rejects.toThrow();
    expect(
      (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
    ).toBe(1);
    await redis.del(MODERATION_DEAD_STREAM);
    await consumer.tick();
    expect(await redis.xLen(MODERATION_DEAD_STREAM)).toBe(1);
    expect(
      (await redis.xPending(MODERATION_STREAM, MODERATION_GROUP)).pending,
    ).toBe(0);
  });
  it.runIf(process.env.RUN_SEMANTIC_INTEGRATION === '1')(
    'publishes the committed event and removes the board through real Map Redis/Cassandra',
    async () => {
      const postId = await create();
      const { PostIndex, POST_GROUP } = await import(
        pathToFileURL(resolve('../map-service/dist/post-index.js')).href
      );
      const { PostConsumer } = await import(
        pathToFileURL(resolve('../map-service/dist/post-consumer.js')).href
      );
      const index = new PostIndex();
      const publisher = new OutboxWorker(outbox);
      try {
        await index.connect();
        const map = new PostConsumer(index);
        await map.initialize();
        const deliver = async () => {
          const batches = (await redis.xReadGroup(
            POST_GROUP,
            'map-test',
            { key: 'post:events', id: '>' },
            { COUNT: 100 },
          )) as any;
          for (const batch of batches ?? [])
            for (const entry of batch.messages) await map.process(entry);
        };
        await publisher.publishPending();
        await deliver();
        expect(await index.getStatus(postId)).toBe('ACTIVE');
        expect(await redis.zScore('map:posts:geo:v1', postId)).not.toBeNull();
        await redis.xAdd(MODERATION_STREAM, '*', fields(postId));
        await consumer.tick();
        await publisher.publishPending();
        await deliver();
        expect(await index.getStatus(postId)).toBe('EXPIRED');
        expect(await redis.zScore('map:posts:geo:v1', postId)).toBeNull();
      } finally {
        await publisher.onModuleDestroy();
        // All Map rows created by this suite are removed before the shared test Cassandra is released.
        const created = await posts.find({}).lean();
        for (const post of created) {
          const row = (
            await index.db.execute(
              'SELECT cell, shard FROM post_locations WHERE post_id = ?',
              [post.postId],
              { prepare: true },
            )
          ).first();
          if (row)
            await index.db.execute(
              'DELETE FROM posts_by_cell WHERE cell = ? AND shard = ? AND post_id = ?',
              [row.get('cell'), row.get('shard'), post.postId],
              { prepare: true },
            );
          await index.db.execute(
            'DELETE FROM post_locations WHERE post_id = ?',
            [post.postId],
            { prepare: true },
          );
          await index.db.execute(
            'DELETE FROM post_status WHERE post_id = ?',
            [post.postId],
            { prepare: true },
          );
        }
        await index.close();
      }
    },
    30000,
  );
});
