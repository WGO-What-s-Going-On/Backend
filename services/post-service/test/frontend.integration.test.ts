import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Test } from '@nestjs/testing';
import { getConnectionToken, getModelToken } from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection } from 'mongoose';
import request from 'supertest';
import { generateKeyPairSync, sign, randomUUID } from 'node:crypto';
import { AppModule } from '../src/app.module.js';
import { UserProfiles } from '../src/post/infrastructure/user-profiles.js';
import { GrpcNearbyPosts } from '../src/post/semantic/grpc-candidates.js';
import { LOCATION_AUTHORIZATION } from '../src/post/application/ports.js';
import { OutboxWorker } from '../src/post/infrastructure/outbox.worker.js';
import { SemanticWorker } from '../src/post/semantic/worker.js';
const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('Frontend contracts against MongoDB', () => {
  let app: INestApplication;
  let ids: string[] = [];
  const headers = { 'x-user-id': '777' };
  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    vi.stubEnv('SEMANTIC_MODEL_ENABLED', 'false');
    vi.stubEnv('POST_REGION_ENABLED', 'false');
    vi.stubEnv(
      'MONGODB_URI',
      'mongodb://localhost:27017/wgo_frontend_integration?replicaSet=rs0',
    );
    const module = await Test.createTestingModule({ imports: [AppModule] })
      .overrideProvider(LOCATION_AUTHORIZATION)
      .useValue({
        assertCanCreate: async () => {},
        assertCanJoin: async () => {},
      })
      .overrideProvider(UserProfiles)
      .useValue({
        names: async (ids: number[]) =>
          new Map(ids.map((id) => [id, `nickname-${id}`])),
      })
      .overrideProvider(GrpcNearbyPosts)
      .useValue({
        page: async () => ({
          items: ids.map((postId) => ({ postId, distanceM: 0 })),
          truncated: false,
          nextCursor: null,
        }),
      })
      .overrideProvider(OutboxWorker)
      .useValue({ wake() {} })
      .overrideProvider(SemanticWorker)
      .useValue({})
      .compile();
    app = module.createNestApplication();
    await app.init();
    await app.get<Connection>(getConnectionToken()).dropDatabase();
  }, 30000);
  afterAll(async () => {
    await app?.close();
    vi.unstubAllEnvs();
  });
  it('creates, queries, reacts, replies, closes and reopens without bypassing ownership', async () => {
    for (const [i, category] of ['NEWS', 'HELP'].entries()) {
      const result = await request(app.getHttpServer())
        .post('/api/v1/posts')
        .set(headers)
        .send({
          title: `news-${i}`,
          content: 'content',
          category,
          latitude: 37 + i * 0.0005,
          longitude: 127,
          radiusM: 150,
          anonymous: i === 1,
        })
        .expect(201);
      ids.push(result.body.postId);
    }
    const base = `/api/v1/posts/${ids[0]}`;
    await request(app.getHttpServer())
      .post(`${base}/participants`)
      .set(headers)
      .send({})
      .expect(201);
    const comment = await request(app.getHttpServer())
      .post(`${base}/comments`)
      .set(headers)
      .send({ content: 'parent' })
      .expect(201);
    const cid = comment.body.commentId;
    expect(comment.body.verified).toBe(true);
    const reply = await request(app.getHttpServer())
      .post(`${base}/comments`)
      .set(headers)
      .send({ content: 'reply', parentCommentId: cid })
      .expect(201);
    expect(reply.body.parentCommentId).toBe(cid);
    await request(app.getHttpServer())
      .post(`${base}/comments`)
      .set(headers)
      .send({ content: 'nested', parentCommentId: reply.body.commentId })
      .expect(404);
    await request(app.getHttpServer())
      .post(`${base}/reactions`)
      .set(headers)
      .send({ type: 'CURIOUS' })
      .expect(201);
    const detail = await request(app.getHttpServer())
      .get(`${base}?latitude=37&longitude=127`)
      .set(headers)
      .expect(200);
    expect(detail.body).toMatchObject({
      authorNickname: 'nickname-777',
      anonymous: false,
      myReaction: 'CURIOUS',
      distanceM: 0,
      reactionCounts: { CURIOUS: 1, HELPFUL: 0, ENDED: 0, STILL_HAPPENING: 0 },
    });
    const comments = await request(app.getHttpServer())
      .get(`${base}/comments`)
      .set(headers)
      .expect(200);
    expect(comments.body.comments).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          authorNickname: 'nickname-777',
          parentCommentId: cid,
          verified: true,
          myReaction: null,
        }),
      ]),
    );
    const page = await request(app.getHttpServer())
      .get('/api/v1/posts/nearby?latitude=37&longitude=127&radiusM=150&limit=1')
      .set(headers)
      .expect(200);
    expect(page.body.posts[0].postId).toBe(ids[0]);
    expect(page.body.nextCursor).toBeTypeOf('string');
    const next = await request(app.getHttpServer())
      .get(
        `/api/v1/posts/nearby?latitude=37&longitude=127&radiusM=150&limit=1&cursor=${page.body.nextCursor}`,
      )
      .set({ 'x-user-id': '888' })
      .expect(200);
    expect(next.body.posts[0]).toMatchObject({
      postId: ids[1],
      anonymous: true,
      authorId: null,
      authorNickname: null,
    });
    await request(app.getHttpServer())
      .patch(base)
      .set({ 'x-user-id': '888' })
      .send({ title: 'stolen' })
      .expect(403);
    await request(app.getHttpServer())
      .patch(base)
      .set(headers)
      .send({ title: 'updated' })
      .expect(204);
    await request(app.getHttpServer())
      .put(`${base}/closed`)
      .set(headers)
      .send({ closed: true })
      .expect(204);
    await request(app.getHttpServer())
      .post(`${base}/comments`)
      .set(headers)
      .send({ content: 'closed' })
      .expect(403);
    const closed = await request(app.getHttpServer())
      .get(base)
      .set(headers)
      .expect(200);
    expect(closed.body.closedAt).toBeTruthy();
    const filtered = await request(app.getHttpServer())
      .get('/api/v1/posts/nearby?latitude=37&longitude=127&category=NEWS')
      .set(headers)
      .expect(200);
    expect(filtered.body.posts).toEqual([]);
    await request(app.getHttpServer())
      .put(`${base}/closed`)
      .set(headers)
      .send({ closed: false })
      .expect(204);
    const reopened = await request(app.getHttpServer())
      .get(base)
      .set(headers)
      .expect(200);
    expect(reopened.body).toMatchObject({ closedAt: null, title: 'updated' });
    const activity = await request(app.getHttpServer())
      .get('/api/v1/posts/me/activity')
      .set(headers)
      .expect(200);
    expect(activity.body.items.length).toBeGreaterThan(0);
    const stats = await request(app.getHttpServer())
      .get('/api/v1/posts/me/level')
      .set(headers)
      .expect(200);
    expect(stats.body).toMatchObject({
      participation: 5,
      score: 0,
      title: '소식통',
    });
  }, 30000);
  it('separates administrative dongs and ranks only qualified users by local winning points', async () => {
    vi.stubEnv('POST_REGION_ENABLED', 'true');
    const posts = app.get(getModelToken('Post')),
      comments = app.get(getModelToken('Comment'));
    for (let i = 0; i < 5; i++) {
      const postId = `post_${randomUUID()}`,
        winner = `comment_${randomUUID()}`,
        now = new Date();
      await posts.create({
        postId,
        authorId: 999,
        title: 'rank',
        content: 'rank',
        category: 'NEWS',
        status: 'ACTIVE',
        locationSnapshot: { latitude: 37, longitude: 127 },
        radiusM: 150,
        createdAt: now,
        updatedAt: now,
        region: {
          code: i < 3 ? '1159053000' : '1159054000',
          name: i < 3 ? '상도1동' : '상도2동',
        },
        vote: { status: 'CLOSED', winner: { commentId: winner } },
      });
      await comments.create([
        {
          postId,
          commentId: winner,
          authorId: 999,
          content: 'winner',
          status: 'ACTIVE',
          createdAt: now,
          reactionCounts: { AGREE: 2 },
        },
        {
          postId,
          commentId: `comment_${randomUUID()}`,
          authorId: 999,
          content: 'other',
          status: 'ACTIVE',
          createdAt: now,
        },
      ]);
    }
    const one = await request(app.getHttpServer())
      .get('/api/v1/posts/me/ranking?regionCode=1159053000')
      .set({ 'x-user-id': '999' })
      .expect(200);
    expect(one.body).toMatchObject({ myRank: 1, myScore: 30 });
    expect(one.body.items[0]).toMatchObject({
      userId: 999,
      picks: 3,
      score: 30,
    });
    const two = await request(app.getHttpServer())
      .get('/api/v1/posts/me/ranking?regionCode=1159054000')
      .set({ 'x-user-id': '999' })
      .expect(200);
    expect(two.body).toMatchObject({ myRank: 1, myScore: 20 });
    vi.stubEnv('POST_REGION_ENABLED', 'false');
  });
  it('requires signed gateway identity in production and rejects forged user context', async () => {
    const { privateKey, publicKey } = generateKeyPairSync('ec', {
      namedCurve: 'prime256v1',
    });
    vi.stubEnv(
      'POST_HTTP_GATEWAY_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...publicKey.export({ format: 'jwk' }),
            kid: 'test',
            alg: 'ES256',
            iss: 'wgo-http-gateway',
          },
        ],
      }),
    );
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const now = Math.floor(Date.now() / 1000);
      const h = Buffer.from(
        JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid: 'test' }),
      ).toString('base64url');
      const p = Buffer.from(
        JSON.stringify({
          iss: 'wgo-http-gateway',
          sub: 'http-gateway',
          aud: 'wgo-post-service',
          userId: '777',
          iat: now,
          exp: now + 30,
        }),
      ).toString('base64url');
      const token = `Bearer ${h}.${p}.${sign('sha256', Buffer.from(`${h}.${p}`), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${ids[0]}`)
        .set(headers)
        .expect(401);
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${ids[0]}`)
        .set({ ...headers, authorization: token })
        .expect(200);
      await request(app.getHttpServer())
        .get(`/api/v1/posts/${ids[0]}`)
        .set({ 'x-user-id': '888', authorization: token })
        .expect(401);
    } finally {
      vi.stubEnv('NODE_ENV', 'test');
    }
  });
});
