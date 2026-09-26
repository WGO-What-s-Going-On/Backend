import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import { createHmac } from 'node:crypto';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { JoinPost } from '../src/post/application/commands.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
const serviceSecret = 'integration-ws-service-secret-at-least-32';
function serviceToken(userId?: number): string {
  const header = Buffer.from(
    JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
  ).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  const payload = Buffer.from(
    JSON.stringify({
      sub: 'ws-gateway',
      iss: 'wgo-ws-gateway',
      aud: 'wgo-post-service',
      iat: now,
      exp: now + 30,
      ...(userId ? { userId } : {}),
    }),
  ).toString('base64url');
  return `${header}.${payload}.${createHmac('sha256', serviceSecret).update(`${header}.${payload}`).digest('base64url')}`;
}

suite('post creation integration', () => {
  let app: INestApplication;
  let connection: Connection;
  let posts: Model<any>;
  let comments: Model<any>;
  let reactions: Model<any>;
  let participants: Model<any>;
  let outbox: Model<any>;
  let worker: OutboxWorker;
  const redis = createClient({ url: 'redis://localhost:6380' });
  let id: string;
  const header = { 'X-User-Id': '123' };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI =
      'mongodb://localhost:27017/wgo_post_integration?replicaSet=rs0';
    process.env.WS_SERVICE_JWT_SECRET = serviceSecret;
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    connection = app.get(getConnectionToken());
    posts = app.get(getModelToken('Post'));
    comments = app.get(getModelToken('Comment'));
    reactions = app.get(getModelToken('Reaction'));
    participants = app.get(getModelToken('Participant'));
    outbox = app.get(getModelToken('Outbox'));
    worker = app.get(OutboxWorker);
    await connection.dropDatabase();
    await Promise.all([
      posts.syncIndexes(),
      comments.syncIndexes(),
      reactions.syncIndexes(),
      participants.syncIndexes(),
      outbox.syncIndexes(),
    ]);
    await redis.connect();
    await redis.del('post:events');
  }, 30000);

  afterAll(async () => {
    await redis.quit();
    await app.close();
  });

  it('creates an active post and its outbox event', async () => {
    const response = await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set(header)
      .send({
        title: 'Test',
        content: 'Details',
        category: 'INCIDENT',
        latitude: 37.5,
        longitude: 127,
        radiusM: 250,
      })
      .expect(201);
    id = response.body.postId;
    expect(response.body.expiresAt).toBeNull();
    expect(await posts.countDocuments({ postId: id, status: 'ACTIVE' })).toBe(
      1,
    );
    expect(
      await outbox.countDocuments({
        aggregateId: id,
        eventType: 'PostCreated',
      }),
    ).toBe(1);
  });

  it('rejects invalid input and missing identity', async () => {
    await request(app.getHttpServer())
      .post('/api/v1/posts')
      .send({})
      .expect(403);
    await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set(header)
      .send({
        title: '',
        content: 'A',
        category: 'INCIDENT',
        latitude: 91,
        longitude: 127,
        radiusM: 250,
      })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/reactions`)
      .set(header)
      .send({ type: 'LOVE' })
      .expect(400);
  });

  it('creates comments, reactions, and participants once', async () => {
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/comments`)
      .set(header)
      .send({ content: 'Hello' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/reactions`)
      .set(header)
      .send({ type: 'LIKE' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/reactions`)
      .set(header)
      .send({ type: 'LIKE' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/participants`)
      .set(header)
      .send({})
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/participants`)
      .set(header)
      .send({})
      .expect(201);
    expect(await comments.countDocuments({ postId: id })).toBe(1);
    expect(await reactions.countDocuments({ postId: id })).toBe(1);
    expect(await participants.countDocuments({ postId: id })).toBe(1);
    expect(await outbox.countDocuments({ aggregateId: id })).toBe(4);
    const post = await posts.findOne({ postId: id }).lean();
    expect(post.counters).toMatchObject({
      commentCount: 1,
      reactionCount: 1,
      participantCount: 1,
    });
  });

  it('records rejoining as a new event', async () => {
    await participants.updateOne(
      { postId: id, userId: 123 },
      { $set: { leftAt: new Date() } },
    );
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/participants`)
      .set(header)
      .send({})
      .expect(201);
    expect(
      await outbox.countDocuments({
        aggregateId: id,
        eventType: 'PostParticipantJoined',
      }),
    ).toBe(2);
  });

  it('rejects missing and inactive posts', async () => {
    const missing = `post_${'0'.repeat(36)}`;
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${missing}/comments`)
      .set(header)
      .send({ content: 'Hi' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${missing}/reactions`)
      .set(header)
      .send({ type: 'LIKE' })
      .expect(404);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${missing}/participants`)
      .set(header)
      .send({})
      .expect(404);
    await posts.updateOne({ postId: id }, { $set: { status: 'EXPIRED' } });
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/comments`)
      .set(header)
      .send({ content: 'Hi' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/reactions`)
      .set(header)
      .send({ type: 'LIKE' })
      .expect(403);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/participants`)
      .set(header)
      .send({})
      .expect(403);
    await posts.updateOne({ postId: id }, { $set: { status: 'ACTIVE' } });
  });

  it('rolls back domain data when outbox insert fails', async () => {
    const before = await comments.countDocuments({ postId: id });
    const postBefore = await posts.findOne({ postId: id }).lean();
    const spy = vi
      .spyOn(outbox, 'create')
      .mockRejectedValueOnce(new Error('outbox unavailable'));
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/comments`)
      .set(header)
      .send({ content: 'Rollback' })
      .expect(500);
    spy.mockRestore();
    expect(await comments.countDocuments({ postId: id })).toBe(before);
    const postAfter = await posts.findOne({ postId: id }).lean();
    expect(postAfter.counters.commentCount).toBe(
      postBefore.counters.commentCount,
    );
  });

  it('publishes four event types and retains eventId when reclaimed', async () => {
    for (let i = 0; i < 5; i++) await worker.publishPending();
    const entries = await redis.xRange('post:events', '-', '+');
    expect(new Set(entries.map((entry) => entry.message.eventType))).toEqual(
      new Set([
        'PostCreated',
        'PostCommentCreated',
        'PostReactionCreated',
        'PostParticipantJoined',
      ]),
    );
    const first = await outbox.findOne({ eventType: 'PostCreated' }).lean();
    await outbox.updateOne(
      { _id: first._id },
      { $set: { status: 'PUBLISHING', claimedUntil: new Date(0) } },
    );
    await worker.publishPending();
    const replay = await redis.xRange('post:events', '-', '+');
    expect(
      replay.filter((entry) => entry.message.eventId === first.eventId),
    ).toHaveLength(2);
  });

  it('rejects development identity and Map stubs in production', async () => {
    process.env.NODE_ENV = 'production';
    try {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(header)
        .send({})
        .expect(503);
      await request(app.getHttpServer())
        .post(`/api/v1/posts/${id}/participants`)
        .set(header)
        .send({})
        .expect(503);
      await expect(app.get(JoinPost).execute(id, 123)).rejects.toMatchObject({
        message: 'Map participation authorization unavailable',
      });
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });

  it('reads active details and paginates active comments without writes', async () => {
    const otherId = `post_${'a'.repeat(36)}`;
    const inactiveId = `post_${'b'.repeat(36)}`;
    const original = await posts.findOne({ postId: id }).lean();
    await posts.create({
      ...original,
      _id: undefined,
      postId: inactiveId,
      status: 'DELETED',
    });
    const timestamp = new Date('2030-09-20T00:00:00.000Z');
    await comments.insertMany([
      {
        commentId: 'read-1',
        postId: id,
        authorId: 1,
        content: 'first',
        status: 'ACTIVE',
        createdAt: timestamp,
      },
      {
        commentId: 'read-2',
        postId: id,
        authorId: 1,
        content: 'second',
        status: 'ACTIVE',
        createdAt: timestamp,
      },
      {
        commentId: 'read-3',
        postId: id,
        authorId: 1,
        content: 'third',
        status: 'ACTIVE',
        createdAt: timestamp,
      },
      {
        commentId: 'read-4',
        postId: id,
        authorId: 1,
        content: 'deleted',
        status: 'DELETED',
        createdAt: timestamp,
      },
    ]);
    const before = await posts.findOne({ postId: id }).lean();
    const outboxBefore = await outbox.countDocuments({});
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}`)
      .expect(200);
    expect(detail.body).toMatchObject({
      postId: id,
      title: 'Test',
      status: 'ACTIVE',
    });
    expect(detail.body).not.toHaveProperty('_id');
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${otherId}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${inactiveId}`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${inactiveId}/comments`)
      .expect(404);
    const first = await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}/comments?limit=1`)
      .expect(200);
    const second = await request(app.getHttpServer())
      .get(
        `/api/v1/posts/${id}/comments?limit=1&cursor=${first.body.nextCursor}`,
      )
      .expect(200);
    const rest = await request(app.getHttpServer())
      .get(
        `/api/v1/posts/${id}/comments?limit=10&cursor=${second.body.nextCursor}`,
      )
      .expect(200);
    const ids = [first.body, second.body, rest.body].flatMap((page) =>
      page.comments.map((comment: any) => comment.commentId),
    );
    expect(ids).toHaveLength(4);
    expect(ids.slice(0, 3)).toEqual(['read-3', 'read-2', 'read-1']);
    expect(ids[3]).toMatch(/^comment_/);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).not.toContain('read-4');
    expect(rest.body.nextCursor).toBeNull();
    expect(first.body.comments[0]).not.toHaveProperty('_id');
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}/comments?cursor=invalid`)
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${otherId}/comments?cursor=${first.body.nextCursor}`)
      .expect(400);
    for (const limit of ['0', '101', '1.5', 'abc'])
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${id}/comments?limit=${limit}`)
        .expect(400);
    const after = await posts.findOne({ postId: id }).lean();
    expect(after.counters).toEqual(before.counters);
    expect(await outbox.countDocuments({})).toBe(outboxBefore);
  });

  it('filters and orders batch reads, exposes inactive metadata, and blocks internal routes in production', async () => {
    const inactiveId = `post_${'b'.repeat(36)}`;
    const secondId = `post_${'d'.repeat(36)}`;
    const missing = `post_${'c'.repeat(36)}`;
    const original = await posts.findOne({ postId: id }).lean();
    await posts.create({
      ...original,
      _id: undefined,
      postId: secondId,
      title: 'Second',
    });
    const batch = await request(app.getHttpServer())
      .post('/internal/v1/posts/batch-get')
      .send({ postIds: [missing, secondId, id, inactiveId, secondId] })
      .expect(201);
    expect(batch.body.posts).toEqual([
      {
        postId: secondId,
        title: 'Second',
        category: 'INCIDENT',
        status: 'ACTIVE',
        createdAt: expect.any(String),
      },
      {
        postId: id,
        title: 'Test',
        category: 'INCIDENT',
        status: 'ACTIVE',
        createdAt: expect.any(String),
      },
    ]);
    await request(app.getHttpServer())
      .post('/internal/v1/posts/batch-get')
      .send({ postIds: [] })
      .expect(201)
      .expect({ posts: [] });
    await request(app.getHttpServer())
      .post('/internal/v1/posts/batch-get')
      .send({ postIds: Array(100).fill(id) })
      .expect(201);
    await request(app.getHttpServer())
      .post('/internal/v1/posts/batch-get')
      .send({ postIds: Array(101).fill(id) })
      .expect(400);
    await request(app.getHttpServer())
      .post('/internal/v1/posts/batch-get')
      .send({ postIds: [123] })
      .expect(400);
    const meta = await request(app.getHttpServer())
      .get(`/internal/v1/posts/${inactiveId}/meta`)
      .expect(200);
    expect(meta.body).toMatchObject({
      postId: inactiveId,
      status: 'DELETED',
      category: 'INCIDENT',
      radiusM: 250,
      locationSnapshot: { latitude: 37.5, longitude: 127 },
    });
    expect(meta.body).not.toHaveProperty('_id');
    await request(app.getHttpServer())
      .get(`/internal/v1/posts/${inactiveId}/status`)
      .expect(200)
      .expect({ postId: inactiveId, status: 'DELETED', expiresAt: null });
    await request(app.getHttpServer())
      .get(`/internal/v1/posts/${missing}/meta`)
      .expect(404);
    await request(app.getHttpServer())
      .get(`/internal/v1/posts/${missing}/status`)
      .expect(404);
    process.env.NODE_ENV = 'production';
    try {
      await request(app.getHttpServer())
        .post('/internal/v1/posts/batch-get')
        .send({ postIds: [] })
        .expect(503);
      await request(app.getHttpServer())
        .get(`/internal/v1/posts/${id}/meta`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/internal/v1/posts/${id}/status`)
        .expect(401);
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });

  it('authenticates internal reads and deduplicates repeated mutations after reconnect', async () => {
    const auth = { Authorization: `Bearer ${serviceToken(123)}` };
    const before = await posts.findOne({ postId: id }).lean();
    const first = await request(app.getHttpServer())
      .post(`/internal/v1/posts/${id}/comments`)
      .set(auth)
      .send({ content: 'via websocket', mutationId: 'reconnect-1' })
      .expect(201);
    const again = await request(app.getHttpServer())
      .post(`/internal/v1/posts/${id}/comments`)
      .set(auth)
      .send({ content: 'via websocket', mutationId: 'reconnect-1' })
      .expect(201);
    expect(again.body.commentId).toBe(first.body.commentId);
    expect(
      await comments.countDocuments({
        postId: id,
        authorId: 123,
        mutationId: 'reconnect-1',
      }),
    ).toBe(1);
    expect(
      (await posts.findOne({ postId: id }).lean()).counters.commentCount,
    ).toBe(before.counters.commentCount + 1);
    await request(app.getHttpServer())
      .get(`/internal/v1/posts/${id}`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .get(`/internal/v1/posts/${id}/comments?limit=1`)
      .set(auth)
      .expect(200);
    await request(app.getHttpServer())
      .post(`/internal/v1/posts/${id}/comments`)
      .set({ Authorization: `Bearer ${serviceToken()}` })
      .send({ content: 'invalid', mutationId: 'missing-user' })
      .expect(400);
    await request(app.getHttpServer())
      .post(`/internal/v1/posts/${id}/comments`)
      .set({ Authorization: 'Bearer invalid' })
      .send({ content: 'invalid', mutationId: 'bad-token' })
      .expect(401);
    process.env.NODE_ENV = 'production';
    try {
      await request(app.getHttpServer())
        .get(`/internal/v1/posts/${id}/status`)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/internal/v1/posts/${id}/status`)
        .set(auth)
        .expect(200);
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
