import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import { getConnectionToken } from '@nestjs/mongoose';
import type { Connection } from 'mongoose';
import { createClient } from 'redis';
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
import { AppModule } from '../src/app.module.js';
import { ApplyContentDecision } from '../src/post/application/content-decision.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import { MongoosePostStore } from '../src/post/infrastructure/mongoose-post.store.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { VoteWorker } from '../src/post/infrastructure/vote.worker.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import {
  ContentDecisionConsumer,
  CONTENT_DECISION_STREAM,
  CONTENT_DECISION_GROUP,
  CONTENT_DECISION_DEAD_STREAM,
} from '../src/post/infrastructure/content-decision-consumer.js';
import { parseContentDecision } from '../src/post/infrastructure/content-decision-event.js';
import { serializePostEvent } from '../src/post/infrastructure/post-event-envelope.js';
import { decisionFields } from './helpers/content-decision.js';
const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'content decisions -> transactional hide -> visibility and outbox',
  () => {
    let app: INestApplication;
    let db: Connection;
    let apply: ApplyContentDecision;
    let consumer: ContentDecisionConsumer;
    const redis = createClient({ url: 'redis://localhost:6380/13' });
    const headers = { 'X-User-Id': '123' };
    beforeAll(async () => {
      vi.stubEnv('NODE_ENV', 'test');
      vi.stubEnv(
        'MONGODB_URI',
        `mongodb://localhost:27017/content_it_${randomUUID().replaceAll('-', '')}?replicaSet=rs0`,
      );
      vi.stubEnv('SEMANTIC_ENABLED', 'false');
      vi.stubEnv('POST_MODERATION_CONSUMER_ENABLED', 'false');
      vi.stubEnv('POST_CONTENT_DECISION_CONSUMER_ENABLED', 'false');
      const module = await Test.createTestingModule({ imports: [AppModule] })
        .overrideProvider(LOCATION_AUTHORIZATION)
        .useValue({
          assertCanCreate: async () => {},
          assertCanJoin: async () => {},
          resolveRegion: async () => ({ code: '1159053000', name: '상도1동' }),
        })
        .overrideProvider(UserProfiles)
        .useValue({ names: async () => new Map() })
        .overrideProvider(OutboxWorker)
        .useValue({ wake() {} })
        .overrideProvider(VoteWorker)
        .useValue({})
        .overrideProvider(ExpirationWorker)
        .useValue({})
        .compile();
      app = module.createNestApplication();
      await app.init();
      db = app.get(getConnectionToken());
      for (const model of Object.values(db.models)) await model.syncIndexes();
      apply = app.get(ApplyContentDecision);
      await redis.connect();
    }, 30000);
    beforeEach(async () => {
      for (const model of Object.values(db.models)) await model.deleteMany({});
      await redis.flushDb();
      consumer = new ContentDecisionConsumer(redis, apply, 0);
      await consumer.initialize();
    });
    afterAll(async () => {
      if (redis.isOpen) await redis.quit();
      await db?.dropDatabase();
      await app?.close();
      vi.unstubAllEnvs();
    });
    async function create() {
      const response = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(headers)
        .send({
          title: 'retain title',
          content: 'retain body',
          category: 'NEWS',
          latitude: 37.5,
          longitude: 127,
          radiusM: 150,
        })
        .expect(201);
      return String(response.body.postId);
    }
    it('hides once under concurrent delivery, retains content and denies public reads', async () => {
      const postId = await create();
      const fields = decisionFields(postId);
      const input = parseContentDecision(fields);
      expect(
        await Promise.all([apply.execute(input), apply.execute(input)]),
      ).toEqual(['APPLIED', 'APPLIED']);
      expect(await db.model('Post').findOne({ postId }).lean()).toMatchObject({
        status: 'HIDDEN',
        title: 'retain title',
        content: 'retain body',
        postVersion: 2,
        vote: { status: 'CANCELLED' },
      });
      expect(await db.model('ModerationReceipt').countDocuments()).toBe(1);
      expect(
        await db.model('Outbox').countDocuments({ eventType: 'PostHidden' }),
      ).toBe(1);
      expect(
        await db.model('Outbox').countDocuments({ eventType: 'PostVoteWon' }),
      ).toBe(0);
      for (const route of [
        `/api/v1/posts/${postId}`,
        `/api/v1/posts/${postId}/comments`,
        `/api/v1/posts/${postId}/media`,
      ])
        await request(app.getHttpServer()).get(route).set(headers).expect(404);
      const activity = await request(app.getHttpServer())
        .get('/api/v1/posts/me/activity')
        .set(headers)
        .expect(200);
      expect(activity.body.items).toEqual([]);
      for (const row of await db.model('Outbox').find({}).lean())
        expect(() => serializePostEvent(row)).not.toThrow();
      await redis.xAdd(CONTENT_DECISION_STREAM, '*', fields);
      await consumer.tick();
      expect(
        (await redis.xPending(CONTENT_DECISION_STREAM, CONTENT_DECISION_GROUP))
          .pending,
      ).toBe(0);
    });
    it('records stale, missing, terminal and already-hidden outcomes without extra effects', async () => {
      const postId = await create();
      await db
        .model('Post')
        .updateOne({ postId }, { $set: { postVersion: 2 } });
      expect(
        await apply.execute(parseContentDecision(decisionFields(postId))),
      ).toBe('STALE');
      expect(
        await apply.execute(
          parseContentDecision(decisionFields(`post_${randomUUID()}`)),
        ),
      ).toBe('NOT_FOUND');
      expect(
        await apply.execute(
          parseContentDecision(
            decisionFields(postId, { targetType: 'POST', postVersion: 2 }),
          ),
        ),
      ).toBe('APPLIED');
      expect(
        await apply.execute(
          parseContentDecision(
            decisionFields(postId, { targetType: 'POST', postVersion: 2 }),
          ),
        ),
      ).toBe('ALREADY_HIDDEN');
      const other = await create();
      await db
        .model('Post')
        .updateOne({ postId: other }, { $set: { status: 'DELETED' } });
      expect(
        await apply.execute(parseContentDecision(decisionFields(other))),
      ).toBe('TERMINAL');
      expect(
        await db
          .model('Outbox')
          .countDocuments({ eventType: 'ContentModerationApplied' }),
      ).toBe(5);
    });
    it('hides a comment without deleting its body and decrements the counter once', async () => {
      const postId = await create();
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${postId}/participants`)
        .set(headers)
        .send({})
        .expect(201);
      const result = await request(app.getHttpServer())
        .post(`/api/v1/posts/${postId}/comments`)
        .set(headers)
        .send({ content: 'retained comment' })
        .expect(201);
      const commentId = result.body.commentId;
      await db.model('Post').updateOne(
        { postId },
        {
          $set: {
            vote: {
              status: 'OPEN',
              candidates: [
                { commentId, content: 'retained comment', votes: 2 },
              ],
              winner: null,
            },
          },
        },
      );
      const input = parseContentDecision(
        decisionFields(postId, {
          targetType: 'COMMENT',
          commentId,
          activityVersion: 1,
        }),
      );
      await apply.execute(input);
      await apply.execute(input);
      expect(await db.model('Post').findOne({ postId }).lean()).toMatchObject({
        vote: { status: 'CANCELLED', candidates: [] },
      });
      expect(
        await db.model('Comment').findOne({ commentId }).lean(),
      ).toMatchObject({
        status: 'HIDDEN',
        content: 'retained comment',
        activityVersion: 2,
      });
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/posts/${postId}/comments`)
            .set(headers)
            .expect(200)
        ).body.comments,
      ).toEqual([]);
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${postId}/comments/${commentId}/media`)
        .set(headers)
        .expect(404);
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${postId}/comments`)
        .set(headers)
        .send({ content: 'reply', parentCommentId: commentId })
        .expect(404);
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/posts/${postId}`)
            .set(headers)
            .expect(200)
        ).body.counters.commentCount,
      ).toBe(0);
      await request(app.getHttpServer())
        .delete(`/api/v1/posts/${postId}/comments/${commentId}`)
        .set(headers)
        .expect(204);
      expect(
        (
          await request(app.getHttpServer())
            .get(`/api/v1/posts/${postId}`)
            .set(headers)
            .expect(200)
        ).body.counters.commentCount,
      ).toBe(0);
    });
    it.each([
      ['STALE', { postVersion: 2, content: 'new safe body' }],
      ['TERMINAL', { status: 'DELETED', postVersion: 2 }],
    ] as const)(
      'rechecks a concurrent edit/deletion on transaction retry: %s',
      async (expected, change) => {
        const postId = await create();
        const store = app.get(MongoosePostStore);
        let first = true;
        const racing = new ApplyContentDecision({
          execute: (work) =>
            store.execute((tx) => {
              const hide = tx.commands.hidePost.bind(tx.commands);
              tx.commands.hidePost = async (...args) => {
                if (first) {
                  first = false;
                  await db
                    .model('Post')
                    .updateOne({ postId }, { $set: change });
                }
                await hide(...args);
              };
              return work(tx);
            }),
        });
        expect(
          await racing.execute(parseContentDecision(decisionFields(postId))),
        ).toBe(expected);
        expect(
          await db.model('Outbox').countDocuments({ eventType: 'PostHidden' }),
        ).toBe(0);
        expect(
          await db.model('ModerationReceipt').findOne({ postId }).lean(),
        ).toMatchObject({ outcome: expected });
      },
    );

    it('rolls back receipt and hidden state when outbox persistence fails', async () => {
      const postId = await create();
      const store = app.get(MongoosePostStore);
      const failing = new ApplyContentDecision({
        execute: (work) =>
          store.execute((tx) => {
            tx.commands.appendEvent = async () => {
              throw new Error('outbox unavailable');
            };
            return work(tx);
          }),
      });
      await expect(
        failing.execute(parseContentDecision(decisionFields(postId))),
      ).rejects.toThrow('outbox unavailable');
      expect(await db.model('ModerationReceipt').countDocuments()).toBe(0);
      expect(await db.model('Post').findOne({ postId }).lean()).toMatchObject({
        status: 'ACTIVE',
        postVersion: 1,
      });
    });
    it('keeps database failures pending, recovers them and quarantines poison before ACK', async () => {
      const postId = await create();
      const fields = decisionFields(postId);
      await redis.xAdd(CONTENT_DECISION_STREAM, '*', fields);
      const failing = new ContentDecisionConsumer(
        redis,
        {
          execute: async () => {
            throw new Error('offline');
          },
        },
        0,
      );
      await failing.tick();
      expect(
        (await redis.xPending(CONTENT_DECISION_STREAM, CONTENT_DECISION_GROUP))
          .pending,
      ).toBe(1);
      await consumer.tick();
      expect(
        (await redis.xPending(CONTENT_DECISION_STREAM, CONTENT_DECISION_GROUP))
          .pending,
      ).toBe(0);
      await redis.xAdd(CONTENT_DECISION_STREAM, '*', { ...fields, data: '{}' });
      await redis.set(CONTENT_DECISION_DEAD_STREAM, 'wrong-type');
      await expect(consumer.tick()).rejects.toThrow();
      expect(
        (await redis.xPending(CONTENT_DECISION_STREAM, CONTENT_DECISION_GROUP))
          .pending,
      ).toBe(1);
      await redis.del(CONTENT_DECISION_DEAD_STREAM);
      await consumer.tick();
      expect(await redis.xLen(CONTENT_DECISION_DEAD_STREAM)).toBe(1);
      expect(
        (await redis.xPending(CONTENT_DECISION_STREAM, CONTENT_DECISION_GROUP))
          .pending,
      ).toBe(0);
    });
  },
);
