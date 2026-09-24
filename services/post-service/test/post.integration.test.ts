import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { JoinPost } from '../src/post/application/commands.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

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
    process.env.MONGODB_URI = 'mongodb://localhost:27017/wgo_post_integration?replicaSet=rs0';
    const module = await Test.createTestingModule({ imports: [AppModule] }).compile();
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
    await Promise.all([posts.syncIndexes(), comments.syncIndexes(), reactions.syncIndexes(), participants.syncIndexes(), outbox.syncIndexes()]);
    await redis.connect();
    await redis.del('post:events');
  }, 30000);

  afterAll(async () => {
    await redis.quit();
    await app.close();
  });

  it('creates an active post and its outbox event', async () => {
    const response = await request(app.getHttpServer()).post('/api/v1/posts').set(header).send({ title: 'Test', content: 'Details', category: 'INCIDENT', latitude: 37.5, longitude: 127, radiusM: 250 }).expect(201);
    id = response.body.postId;
    expect(response.body.expiresAt).toBeNull();
    expect(await posts.countDocuments({ postId: id, status: 'ACTIVE' })).toBe(1);
    expect(await outbox.countDocuments({ aggregateId: id, eventType: 'PostCreated' })).toBe(1);
  });

  it('rejects invalid input and missing identity', async () => {
    await request(app.getHttpServer()).post('/api/v1/posts').send({}).expect(403);
    await request(app.getHttpServer()).post('/api/v1/posts').set(header).send({ title: '', content: 'A', category: 'INCIDENT', latitude: 91, longitude: 127, radiusM: 250 }).expect(400);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/reactions`).set(header).send({ type: 'LOVE' }).expect(400);
  });

  it('creates comments, reactions, and participants once', async () => {
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/comments`).set(header).send({ content: 'Hello' }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/reactions`).set(header).send({ type: 'LIKE' }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/reactions`).set(header).send({ type: 'LIKE' }).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/participants`).set(header).send({}).expect(201);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/participants`).set(header).send({}).expect(201);
    expect(await comments.countDocuments({ postId: id })).toBe(1);
    expect(await reactions.countDocuments({ postId: id })).toBe(1);
    expect(await participants.countDocuments({ postId: id })).toBe(1);
    expect(await outbox.countDocuments({ aggregateId: id })).toBe(4);
    const post = await posts.findOne({ postId: id }).lean();
    expect(post.counters).toMatchObject({ commentCount: 1, reactionCount: 1, participantCount: 1 });
  });

  it('records rejoining as a new event', async () => {
    await participants.updateOne({ postId: id, userId: 123 }, { $set: { leftAt: new Date() } });
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/participants`).set(header).send({}).expect(201);
    expect(await outbox.countDocuments({ aggregateId: id, eventType: 'PostParticipantJoined' })).toBe(2);
  });

  it('rejects missing and inactive posts', async () => {
    const missing = `post_${'0'.repeat(36)}`;
    await request(app.getHttpServer()).post(`/api/v1/posts/${missing}/comments`).set(header).send({ content: 'Hi' }).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/posts/${missing}/reactions`).set(header).send({ type: 'LIKE' }).expect(404);
    await request(app.getHttpServer()).post(`/api/v1/posts/${missing}/participants`).set(header).send({}).expect(404);
    await posts.updateOne({ postId: id }, { $set: { status: 'EXPIRED' } });
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/comments`).set(header).send({ content: 'Hi' }).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/reactions`).set(header).send({ type: 'LIKE' }).expect(403);
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/participants`).set(header).send({}).expect(403);
    await posts.updateOne({ postId: id }, { $set: { status: 'ACTIVE' } });
  });

  it('rolls back domain data when outbox insert fails', async () => {
    const before = await comments.countDocuments({ postId: id });
    const postBefore = await posts.findOne({ postId: id }).lean();
    const spy = vi.spyOn(outbox, 'create').mockRejectedValueOnce(new Error('outbox unavailable'));
    await request(app.getHttpServer()).post(`/api/v1/posts/${id}/comments`).set(header).send({ content: 'Rollback' }).expect(500);
    spy.mockRestore();
    expect(await comments.countDocuments({ postId: id })).toBe(before);
    const postAfter = await posts.findOne({ postId: id }).lean();
    expect(postAfter.counters.commentCount).toBe(postBefore.counters.commentCount);
  });

  it('publishes four event types and retains eventId when reclaimed', async () => {
    for (let i = 0; i < 5; i++) await worker.publishPending();
    const entries = await redis.xRange('post:events', '-', '+');
    expect(new Set(entries.map((entry) => entry.message.eventType))).toEqual(new Set(['PostCreated', 'PostCommentCreated', 'PostReactionCreated', 'PostParticipantJoined']));
    const first = await outbox.findOne({ eventType: 'PostCreated' }).lean();
    await outbox.updateOne({ _id: first._id }, { $set: { status: 'PUBLISHING', claimedUntil: new Date(0) } });
    await worker.publishPending();
    const replay = await redis.xRange('post:events', '-', '+');
    expect(replay.filter((entry) => entry.message.eventId === first.eventId)).toHaveLength(2);
  });

  it('rejects development identity and Map stubs in production', async () => {
    process.env.NODE_ENV = 'production';
    try {
      await request(app.getHttpServer()).post('/api/v1/posts').set(header).send({}).expect(503);
      await request(app.getHttpServer()).post(`/api/v1/posts/${id}/participants`).set(header).send({}).expect(503);
      await expect(app.get(JoinPost).execute(id, 123)).rejects.toMatchObject({ message: 'Map participation authorization unavailable' });
    } finally {
      process.env.NODE_ENV = 'test';
    }
  });
});
