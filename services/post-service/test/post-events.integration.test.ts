import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { ExpirationWorker } from '../src/post/infrastructure/expiration.worker.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { MongoosePostStore } from '../src/post/infrastructure/mongoose-post.store.js';
import { OutboxRecovery } from '../src/post/infrastructure/outbox-recovery.js';
import {
  CreateComment,
  CreateReaction,
  JoinPost,
} from '../src/post/application/commands.js';
import type { PostUnitOfWork } from '../src/post/application/ports.js';
import { HashPartitionStrategy } from '../src/post/application/partition.js';
import { createClient } from 'redis';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('post activity event contracts', () => {
  let app: INestApplication;
  let db: Connection;
  let outbox: Model<any>;
  let lifecycle: PostLifecycle;
  const wake = vi.fn();
  const redis = createClient({ url: 'redis://localhost:6380/13' });
  const actor = { 'X-User-Id': '123' };
  const other = { 'X-User-Id': '456' };
  const input = {
    title: 'Test',
    content: 'Details',
    category: 'INCIDENT',
    latitude: 37.5,
    longitude: 127,
    radiusM: 250,
  };
  const create = async () =>
    (
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(actor)
        .send(input)
        .expect(201)
    ).body.postId as string;
  const events = (postId: string, eventType: string) =>
    outbox
      .find({ aggregateId: postId, eventType })
      .sort({ 'payload.activityVersion': 1 })
      .lean();

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv(
      'MONGODB_URI',
      'mongodb://localhost:27017/wgo_post_events_integration?replicaSet=rs0',
    );
    vi.stubEnv('SEMANTIC_MODEL_ENABLED', 'false');
    vi.stubEnv('POST_BUCKET_COUNT', '4');
    vi.stubEnv('REDIS_URL', 'redis://localhost:6380/13');
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOCATION_AUTHORIZATION)
      .useValue({
        assertCanCreate: async () => {},
        assertCanJoin: async () => {},
      })
      .overrideProvider(OutboxWorker)
      .useValue({ wake })
      .compile();
    app = module.createNestApplication();
    await app.listen(0, '127.0.0.1');
    await app.get(ExpirationWorker).onModuleDestroy();
    db = app.get(getConnectionToken());
    await db.dropDatabase();
    for (const model of Object.values(db.models)) await model.syncIndexes();
    outbox = app.get(getModelToken('Outbox'));
    lifecycle = app.get(PostLifecycle);
    await redis.connect();
    await redis.del('post:events');
  }, 30000);

  afterAll(async () => {
    if (redis.isOpen) {
      await redis.del('post:events');
      await redis.quit();
    }
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('persists author context and monotonically versions concurrent reaction toggles', async () => {
    const id = await create();
    const path = `/api/v1/posts/${id}/reactions`;
    await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app.getHttpServer())
          .post(path)
          .set(other)
          .send({ type: 'LIKE' })
          .expect(201),
      ),
    );
    await Promise.all(
      Array.from({ length: 3 }, () =>
        request(app.getHttpServer()).delete(path).set(other).expect(204),
      ),
    );
    await request(app.getHttpServer())
      .post(path)
      .set(other)
      .send({ type: 'LIKE' })
      .expect(201);
    expect(
      (await events(id, 'PostReactionCreated')).map(
        (row) => row.payload.activityVersion,
      ),
    ).toEqual([1, 3]);
    const removed = await events(id, 'PostReactionRemoved');
    expect(removed).toHaveLength(1);
    expect(removed[0].payload).toMatchObject({
      postAuthorId: 123,
      postCategory: 'INCIDENT',
      activityVersion: 2,
      reaction: { postId: id, userId: 456, type: 'LIKE' },
    });
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}`)
      .expect(200);
    expect(detail.body.counters.reactionCount).toBe(1);
  });

  it('authorizes comment deletion and emits no second event on retry', async () => {
    const id = await create();
    const result = await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/comments`)
      .set(other)
      .send({ content: 'hello' })
      .expect(201);
    const path = `/api/v1/posts/${id}/comments/${result.body.commentId}`;
    await request(app.getHttpServer()).delete(path).set(actor).expect(403);
    await Promise.all([
      request(app.getHttpServer()).delete(path).set(other).expect(204),
      request(app.getHttpServer()).delete(path).set(other).expect(204),
    ]);
    const deleted = await events(id, 'PostCommentDeleted');
    expect(deleted).toHaveLength(1);
    expect(deleted[0].payload).toMatchObject({
      postAuthorId: 123,
      activityVersion: 2,
      actor: { type: 'USER', userId: 456 },
      reason: 'USER_REQUEST',
    });
    expect(deleted[0].payload.comment).not.toHaveProperty('content');
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/posts/${id}`)
          .expect(200)
      ).body.counters.commentCount,
    ).toBe(0);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/posts/${id}/comments`)
          .expect(200)
      ).body.comments,
    ).toEqual([]);
    const another = await create();
    await request(app.getHttpServer())
      .delete(`/api/v1/posts/${another}/comments/${result.body.commentId}`)
      .set(other)
      .expect(404);
  });

  it('retains participation versions across leave and rejoin', async () => {
    const id = await create();
    const path = `/api/v1/posts/${id}/participants`;
    await request(app.getHttpServer())
      .post(path)
      .set(other)
      .send({})
      .expect(201);
    await request(app.getHttpServer()).delete(path).set(other).expect(204);
    await request(app.getHttpServer()).delete(path).set(other).expect(204);
    await request(app.getHttpServer())
      .post(path)
      .set(other)
      .send({})
      .expect(201);
    expect(
      (await events(id, 'PostParticipantJoined')).map(
        (row) => row.payload.activityVersion,
      ),
    ).toEqual([1, 3]);
    expect(
      (await events(id, 'PostParticipantLeft'))[0].payload.activityVersion,
    ).toBe(2);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/posts/${id}`)
          .expect(200)
      ).body.counters.participantCount,
    ).toBe(1);
  });

  it('deletes once, enforces ownership and rejects later new activities', async () => {
    const id = await create();
    const path = `/api/v1/posts/${id}`;
    await request(app.getHttpServer()).delete(path).set(other).expect(403);
    await Promise.all([
      request(app.getHttpServer()).delete(path).set(actor).expect(204),
      request(app.getHttpServer()).delete(path).set(actor).expect(204),
    ]);
    expect(await events(id, 'PostDeleted')).toHaveLength(1);
    await request(app.getHttpServer()).get(path).expect(404);
    await request(app.getHttpServer())
      .post(`${path}/comments`)
      .set(other)
      .send({ content: 'late' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`${path}/reactions`)
      .set(other)
      .send({ type: 'LIKE' })
      .expect(403);
  });

  it('expires due posts exactly once and never expires deleted posts', async () => {
    const id = await create();
    const due = new Date(Date.now() - 1000);
    await lifecycle.scheduleExpiration(id, due);
    await Promise.all([lifecycle.expire(id), lifecycle.expire(id)]);
    const rows = await events(id, 'PostExpired');
    expect(rows).toHaveLength(1);
    expect(rows[0].payload.post.expiresAt).toEqual(due);
    await request(app.getHttpServer()).get(`/api/v1/posts/${id}`).expect(404);
    const deletedId = await create();
    await lifecycle.scheduleExpiration(deletedId, due);
    await request(app.getHttpServer())
      .delete(`/api/v1/posts/${deletedId}`)
      .set(actor)
      .expect(204);
    await lifecycle.expire(deletedId);
    expect(await events(deletedId, 'PostExpired')).toHaveLength(0);
  });

  it.each(['comment', 'reaction', 'participant'] as const)(
    'rejects a %s using an ACTIVE snapshot after deletion commits',
    async (kind) => {
      const id = await create();
      const store = app.get(MongoosePostStore);
      let release!: () => void;
      let observed!: () => void;
      const paused = new Promise<void>((resolve) => {
        observed = resolve;
      });
      const gate = new Promise<void>((resolve) => {
        release = resolve;
      });
      let first = true;
      const uow: PostUnitOfWork = {
        execute: (work) =>
          store.execute((tx) => {
            const findPost = tx.queries.findPost.bind(tx.queries);
            tx.queries.findPost = async (postId) => {
              const snapshot = await findPost(postId);
              if (first) {
                first = false;
                observed();
                await gate;
              }
              return snapshot;
            };
            return work(tx);
          }),
      };
      const partition = new HashPartitionStrategy();
      const work =
        kind === 'comment'
          ? new CreateComment(uow, store, partition).execute(id, 'late', 456)
          : kind === 'reaction'
            ? new CreateReaction(uow, store, partition).execute(id, 456)
            : new JoinPost(
                uow,
                store,
                {
                  assertCanCreate: async () => {},
                  assertCanJoin: async () => {},
                },
                partition,
              ).execute(id, 456);
      const rejected = expect(work).rejects.toThrow('Post is not active');
      await paused;
      try {
        await lifecycle.deletePost(id, 123);
      } finally {
        release();
      }
      await rejected;
      expect(
        await outbox.countDocuments({
          aggregateId: id,
          eventType: { $nin: ['PostCreated', 'PostDeleted'] },
        }),
      ).toBe(0);
    },
  );

  it('rolls back status and counters if saving its event fails', async () => {
    const id = await create();
    const spy = vi
      .spyOn(outbox, 'create')
      .mockRejectedValueOnce(new Error('outbox write failed'));
    try {
      await expect(lifecycle.deletePost(id, 123)).rejects.toThrow(
        'outbox write failed',
      );
    } finally {
      spy.mockRestore();
    }
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/posts/${id}`)
          .expect(200)
      ).body.status,
    ).toBe('ACTIVE');
    expect(await events(id, 'PostDeleted')).toHaveLength(0);
    expect(
      await db
        .model('Counter')
        .countDocuments({ postId: id, lifecycleFence: { $gt: 0 } }),
    ).toBe(0);
  });

  it('uses legacy counter baselines and versions without copying their counts', async () => {
    const id = await create();
    const reaction = await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/reactions`)
      .set(other)
      .send({ type: 'LIKE' })
      .expect(201);
    expect(reaction.body).not.toHaveProperty('activityVersion');
    await db.model('Counter').deleteMany({ postId: id });
    await db
      .model('Post')
      .updateOne(
        { postId: id },
        { $set: { 'counters.reactionCount': 1 }, $unset: { postVersion: 1 } },
      );
    await db
      .model('Reaction')
      .updateOne(
        { postId: id },
        { $unset: { activityVersion: 1, bucketId: 1, removedAt: 1 } },
      );
    await request(app.getHttpServer())
      .delete(`/api/v1/posts/${id}/reactions`)
      .set(other)
      .expect(204);
    expect(
      (
        await request(app.getHttpServer())
          .get(`/api/v1/posts/${id}`)
          .expect(200)
      ).body.counters.reactionCount,
    ).toBe(0);
    expect(
      (await events(id, 'PostReactionRemoved'))[0].payload.activityVersion,
    ).toBe(2);
    await lifecycle.deletePost(id, 123);
    expect((await events(id, 'PostDeleted'))[0].payload.postVersion).toBe(2);
  });

  it('stores applied moderation context and processes expiration batches', async () => {
    const id = await create();
    await lifecycle.moderatePost(id, 'decision-123');
    expect((await events(id, 'PostDeleted'))[0].payload).toMatchObject({
      actor: { type: 'MODERATION', userId: null },
      reason: 'MODERATION_VIOLATION',
      moderationDecisionId: 'decision-123',
    });
    const due = await create();
    const future = await create();
    await lifecycle.scheduleExpiration(due, new Date(Date.now() - 1000));
    await lifecycle.scheduleExpiration(future, new Date(Date.now() + 60000));
    // 기한이 지났다면 scheduler가 아직 처리하지 않았어도 새 활동과 공개 조회를 거부한다.
    await request(app.getHttpServer()).get(`/api/v1/posts/${due}`).expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${due}/comments`)
      .set(other)
      .send({ content: 'late' })
      .expect(403);
    const scheduler = new ExpirationWorker(db.model('Post'), lifecycle);
    try {
      await scheduler.runOnce();
    } finally {
      await scheduler.onModuleDestroy();
    }
    expect(await events(due, 'PostExpired')).toHaveLength(1);
    expect(await events(future, 'PostExpired')).toHaveLength(0);
  });

  it('publishes all nine contracts and safely replays quarantined events with the same ID', async () => {
    const worker = new OutboxWorker(outbox);
    try {
      await worker.publishPending();
      const entries = await redis.xRange('post:events', '-', '+');
      expect(new Set(entries.map((entry) => entry.message.eventType))).toEqual(
        new Set([
          'PostCreated',
          'PostCommentCreated',
          'PostReactionCreated',
          'PostParticipantJoined',
          'PostReactionRemoved',
          'PostCommentDeleted',
          'PostDeleted',
          'PostParticipantLeft',
          'PostExpired',
        ]),
      );
      for (const entry of entries) {
        const data = JSON.parse(entry.message.data!);
        expect(data).toMatchObject({
          eventId: entry.message.eventId,
          eventType: entry.message.eventType,
          schemaVersion: 1,
          producer: 'post-service',
        });
        expect(data).not.toHaveProperty('payload');
      }
      const row = await outbox
        .findOne({ eventType: 'PostCreated', status: 'PUBLISHED' })
        .lean();
      await outbox.updateOne(
        { _id: row!._id },
        {
          $set: {
            status: 'FAILED',
            failedAt: new Date(),
            lastError: 'ambiguous result',
            attemptCount: 10,
          },
        },
      );
      const recovery = new OutboxRecovery(outbox);
      expect(
        (await recovery.failed()).some((item) => item.eventId === row!.eventId),
      ).toBe(true);
      const results = await Promise.allSettled([
        recovery.retry(row!.eventId, 'Redis recovered'),
        recovery.retry(row!.eventId, 'Redis recovered'),
      ]);
      expect(
        results.filter((item) => item.status === 'fulfilled'),
      ).toHaveLength(1);
      await worker.publishPending();
      const copies = (await redis.xRange('post:events', '-', '+')).filter(
        (entry) => entry.message.eventId === row!.eventId,
      );
      expect(copies).toHaveLength(2);
      expect(copies[1]!.message.data).toBe(copies[0]!.message.data);
      await expect(
        recovery.retry(row!.eventId, 'duplicate operator request'),
      ).rejects.toThrow('FAILED event not found');
      const saved = await outbox.findById(row!._id).lean();
      expect(saved).toMatchObject({
        status: 'PUBLISHED',
        replayCount: 1,
        attemptCount: 1,
        replayReason: 'Redis recovered',
      });
    } finally {
      await worker.onModuleDestroy();
    }
  });
});
