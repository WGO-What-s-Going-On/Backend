import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { Connection, Model } from 'mongoose';
import { createClient } from 'redis';
import {
  createHmac,
  generateKeyPairSync,
  verify,
  createPublicKey,
} from 'node:crypto';
import {
  Server,
  ServerCredentials,
  loadPackageDefinition,
} from '@grpc/grpc-js';
import { loadSync } from '@grpc/proto-loader';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { AppModule } from '../src/app.module.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { JoinPost } from '../src/post/application/commands.js';
import { HashPartitionStrategy } from '../src/post/application/partition.js';

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
  let counters: Model<any>;
  let participants: Model<any>;
  let outbox: Model<any>;
  let worker: OutboxWorker;
  let map: Server;
  let mapUnavailable = false;
  let mapTimeout = false;
  const mapKeys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const redis = createClient({ url: 'redis://localhost:6380' });
  let id: string;
  const header = { 'X-User-Id': '123' };

  beforeAll(async () => {
    process.env.NODE_ENV = 'test';
    process.env.MONGODB_URI =
      'mongodb://localhost:27017/wgo_post_integration?replicaSet=rs0';
    process.env.WS_SERVICE_JWT_SECRET = serviceSecret;
    process.env.POST_SERVICE_SIGNING_JWK = JSON.stringify({
      ...mapKeys.privateKey.export({ format: 'jwk' }),
      alg: 'ES256',
      kid: 'post-integration',
    });
    map = new Server();
    const proto = loadPackageDefinition(
      loadSync('contracts/map-authorization.proto', { longs: String }),
    ) as any;
    const check = (call: any, callback: any) => {
      const token = String(call.metadata.get('authorization')[0] ?? '').replace(
        /^Bearer /,
        '',
      );
      const [jwtHeader, jwtPayload, jwtSignature] = token.split('.');
      if (!jwtHeader || !jwtPayload || !jwtSignature)
        return callback({ code: 16, message: 'Invalid service token' });
      const signature = verify(
        'sha256',
        Buffer.from(`${jwtHeader}.${jwtPayload}`),
        { key: createPublicKey(mapKeys.privateKey), dsaEncoding: 'ieee-p1363' },
        Buffer.from(jwtSignature, 'base64url'),
      );
      const tokenHeader = JSON.parse(
        Buffer.from(jwtHeader, 'base64url').toString(),
      );
      const claims = JSON.parse(
        Buffer.from(jwtPayload, 'base64url').toString(),
      );
      if (
        !signature ||
        tokenHeader.alg !== 'ES256' ||
        tokenHeader.typ !== 'wgo-service+jwt' ||
        tokenHeader.kid !== 'post-integration' ||
        claims.iss !== 'wgo-post-service' ||
        claims.aud !== 'wgo-map-service' ||
        claims.sub !== 'post-service' ||
        !Number.isInteger(claims.iat) ||
        !Number.isInteger(claims.exp) ||
        claims.exp - claims.iat !== 30 ||
        claims.exp <= Math.floor(Date.now() / 1000)
      )
        return callback({ code: 16, message: 'Invalid service token' });
      if (mapUnavailable)
        return callback({ code: 14, message: 'Map unavailable' });
      if (mapTimeout) {
        setTimeout(() => callback(null, { allowed: true, reason: '' }), 200);
        return;
      }
      callback(null, {
        allowed: call.request.userId === '123',
        reason: call.request.userId === '123' ? '' : 'LOCATION_MISSING',
      });
    };
    map.addService(proto.wgo.map.v1.MapAuthorization.service, {
      CheckPostCreation: check,
      CheckPostParticipation: check,
    });
    const mapPort = await new Promise<number>((resolve, reject) =>
      map.bindAsync(
        '127.0.0.1:0',
        ServerCredentials.createInsecure(),
        (error, port) => (error ? reject(error) : resolve(port)),
      ),
    );
    process.env.MAP_GRPC_ADDRESS = `127.0.0.1:${mapPort}`;
    const module = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    app = module.createNestApplication();
    await app.init();
    connection = app.get(getConnectionToken());
    posts = app.get(getModelToken('Post'));
    comments = app.get(getModelToken('Comment'));
    reactions = app.get(getModelToken('Reaction'));
    counters = app.get(getModelToken('Counter'));
    participants = app.get(getModelToken('Participant'));
    outbox = app.get(getModelToken('Outbox'));
    worker = app.get(OutboxWorker);
    await connection.dropDatabase();
    await Promise.all([
      posts.syncIndexes(),
      comments.syncIndexes(),
      reactions.syncIndexes(),
      counters.syncIndexes(),
      participants.syncIndexes(),
      outbox.syncIndexes(),
    ]);
    await redis.connect();
    await redis.del('post:events');
  }, 30000);

  afterAll(async () => {
    map.forceShutdown();
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

  it('does not record a post or outbox event after location denial or Map failure', async () => {
    const beforePosts = await posts.countDocuments();
    const beforeEvents = await outbox.countDocuments();
    const body = {
      title: 'Denied',
      content: 'Details',
      category: 'INCIDENT',
      latitude: 37.5,
      longitude: 127,
      radiusM: 250,
    };
    await request(app.getHttpServer())
      .post('/api/v1/posts')
      .set('X-User-Id', '456')
      .send(body)
      .expect(403);
    mapUnavailable = true;
    try {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(header)
        .send(body)
        .expect(503);
    } finally {
      mapUnavailable = false;
    }
    process.env.POST_SERVICE_SIGNING_JWK = JSON.stringify({
      ...mapKeys.privateKey.export({ format: 'jwk' }),
      alg: 'ES256',
      kid: 'wrong-kid',
    });
    try {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(header)
        .send(body)
        .expect(503);
    } finally {
      process.env.POST_SERVICE_SIGNING_JWK = JSON.stringify({
        ...mapKeys.privateKey.export({ format: 'jwk' }),
        alg: 'ES256',
        kid: 'post-integration',
      });
    }
    process.env.POST_SERVICE_SIGNING_JWK = '{';
    try {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(header)
        .send(body)
        .expect(503);
    } finally {
      process.env.POST_SERVICE_SIGNING_JWK = JSON.stringify({
        ...mapKeys.privateKey.export({ format: 'jwk' }),
        alg: 'ES256',
        kid: 'post-integration',
      });
    }
    const beforeParticipants = await participants.countDocuments();
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${id}/participants`)
      .set('X-User-Id', '456')
      .send({})
      .expect(403);
    expect(await participants.countDocuments()).toBe(beforeParticipants);
    mapTimeout = true;
    process.env.MAP_GRPC_TIMEOUT_MS = '50';
    try {
      await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(header)
        .send(body)
        .expect(503);
    } finally {
      mapTimeout = false;
      delete process.env.MAP_GRPC_TIMEOUT_MS;
    }
    expect(await posts.countDocuments()).toBe(beforePosts);
    expect(await outbox.countDocuments()).toBe(beforeEvents);
  }, 10000);

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
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}`)
      .expect(200);
    expect(detail.body.counters).toMatchObject({
      commentCount: 1,
      reactionCount: 1,
      participantCount: 1,
    });
    expect(
      (await posts.findOne({ postId: id }).lean()).counters.commentCount,
    ).toBe(0);
    expect((await comments.findOne({ postId: id }).lean()).bucketId).toBe(0);
    expect((await reactions.findOne({ postId: id }).lean()).bucketId).toBe(0);
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
    const counterBefore = await counters
      .findOne({ postId: id, bucketId: 0, metric: 'commentCount' })
      .lean();
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
    expect(
      (
        await counters
          .findOne({ postId: id, bucketId: 0, metric: 'commentCount' })
          .lean()
      ).count,
    ).toBe(counterBefore.count);
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
      mapUnavailable = true;
      await expect(app.get(JoinPost).execute(id, 123)).rejects.toMatchObject({
        message: 'Map authorization unavailable',
      });
    } finally {
      mapUnavailable = false;
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

  it('merges bucketed and legacy comments with a stable cursor', async () => {
    const bucketedId = `post_${'e'.repeat(36)}`;
    const original = await posts.findOne({ postId: id }).lean();
    await posts.create({
      ...original,
      _id: undefined,
      postId: bucketedId,
      bucketCount: 4,
      counters: {
        viewCount: 0,
        commentCount: 0,
        reactionCount: 0,
        participantCount: 0,
      },
    });
    const strategy = new HashPartitionStrategy();
    const expected = Array.from({ length: 12 }, (_, index) => ({
      commentId: `bucket-read-${index}`,
      postId: bucketedId,
      bucketId: strategy.resolveBucket(`bucket-read-${index}`, 4),
      authorId: 123,
      content: `comment ${index}`,
      status: 'ACTIVE',
      createdAt: new Date(Date.UTC(2031, 0, 1, 0, 0, index)),
    }));
    await comments.insertMany(expected);
    await comments.collection.insertOne({
      commentId: 'legacy-read',
      postId: bucketedId,
      authorId: 123,
      content: 'legacy',
      status: 'ACTIVE',
      createdAt: new Date('2031-01-01T00:00:12.000Z'),
    });
    expect(new Set(expected.map((comment) => comment.bucketId)).size).toBe(4);
    const ids: string[] = [];
    let cursor: string | null = null;
    do {
      const pageUrl: string = `/api/v1/posts/${bucketedId}/comments?limit=4${cursor ? `&cursor=${cursor}` : ''}`;
      const page: request.Response = await request(app.getHttpServer())
        .get(pageUrl)
        .expect(200);
      ids.push(...page.body.comments.map((comment: any) => comment.commentId));
      expect(page.body.comments[0]).not.toHaveProperty('bucketId');
      cursor = page.body.nextCursor;
    } while (cursor);
    expect(ids).toEqual([
      'legacy-read',
      ...expected.map((row) => row.commentId).reverse(),
    ]);
    const first = await request(app.getHttpServer())
      .post(`/api/v1/posts/${bucketedId}/comments`)
      .set(header)
      .send({ content: 'new comment' })
      .expect(201);
    expect(
      (await comments.findOne({ commentId: first.body.commentId }).lean())
        .bucketId,
    ).toBe(strategy.resolveBucket(first.body.commentId, 4));
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${bucketedId}/reactions`)
      .set(header)
      .send({ type: 'LIKE' })
      .expect(201);
    await request(app.getHttpServer())
      .post(`/api/v1/posts/${bucketedId}/reactions`)
      .set(header)
      .send({ type: 'LIKE' })
      .expect(201);
    expect(
      await reactions.countDocuments({ postId: bucketedId, userId: 123 }),
    ).toBe(1);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/posts/${bucketedId}`)
      .expect(200);
    expect(detail.body.counters.commentCount).toBe(1);
    expect(detail.body.counters.reactionCount).toBe(1);
  });

  it('keeps legacy post counters as the baseline when bucketCount is absent', async () => {
    const legacyId = `post_${'f'.repeat(36)}`;
    const original = await posts.findOne({ postId: id }).lean();
    await posts.create({
      ...original,
      _id: undefined,
      postId: legacyId,
      counters: {
        viewCount: 3,
        commentCount: 5,
        reactionCount: 0,
        participantCount: 0,
      },
    });
    await posts.collection.updateOne(
      { postId: legacyId },
      { $unset: { bucketCount: '' } },
    );
    const response = await request(app.getHttpServer())
      .post(`/api/v1/posts/${legacyId}/comments`)
      .set(header)
      .send({ content: 'legacy post comment' })
      .expect(201);
    expect(
      (await comments.findOne({ commentId: response.body.commentId }).lean())
        .bucketId,
    ).toBe(0);
    const detail = await request(app.getHttpServer())
      .get(`/api/v1/posts/${legacyId}`)
      .expect(200);
    expect(detail.body.counters).toMatchObject({
      viewCount: 3,
      commentCount: 6,
    });
    expect(
      (await posts.findOne({ postId: legacyId }).lean()).counters.commentCount,
    ).toBe(5);
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
    ).toBe(before.counters.commentCount);
    expect(
      (
        await counters
          .findOne({ postId: id, bucketId: 0, metric: 'commentCount' })
          .lean()
      ).count,
    ).toBeGreaterThan(0);
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
