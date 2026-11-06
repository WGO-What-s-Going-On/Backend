import 'reflect-metadata';
import { randomUUID, generateKeyPairSync, sign, createHmac } from 'node:crypto';
import { Test } from '@nestjs/testing';
import {
  MongooseModule,
  getConnectionToken,
  getModelToken,
} from '@nestjs/mongoose';
import type { INestApplication } from '@nestjs/common';
import type { Connection, Model } from 'mongoose';
import request from 'supertest';
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import {
  PostController,
  InternalPostController,
} from '../src/post/post.controller.js';
import {
  CreatePost,
  CreateComment,
  CreateCommentReaction,
  CreateReaction,
  JoinPost,
} from '../src/post/application/commands.js';
import { ReadPosts } from '../src/post/application/queries.js';
import { POST_STATE_QUERIES } from '../src/post/application/ports.js';
import {
  HashPartitionStrategy,
  PARTITION_STRATEGY,
} from '../src/post/application/partition.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { FindSimilarPosts } from '../src/post/semantic/search.js';
import { MediaService } from '../src/post/media/media.service.js';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { MongoosePostRead } from '../src/post/infrastructure/mongoose-post.read.js';
import {
  DailyPostViewSchema,
  MongoosePostViews,
  type DailyPostView,
} from '../src/post/infrastructure/mongoose-post.views.js';
import {
  PostSchema,
  CounterSchema,
  CommentSchema,
} from '../src/post/infrastructure/post.schemas.js';
import type { PostRecord } from '../src/post/domain/post.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

suite('daily post view HTTP integration', () => {
  let app: INestApplication;
  let db: Connection;
  let posts: Model<PostRecord>;
  let receipts: Model<DailyPostView>;
  let counters: Model<{
    postId: string;
    bucketId: number;
    metric: string;
    count: number;
  }>;
  let id: string;
  const createdAt = new Date('2026-11-01T00:00:00Z');
  const get = (user?: number) => {
    const call = request(app.getHttpServer()).get(`/api/v1/posts/${id}`);
    return user === undefined ? call : call.set('x-user-id', String(user));
  };

  beforeAll(async () => {
    vi.stubEnv('NODE_ENV', 'test');
    const module = await Test.createTestingModule({
      imports: [
        MongooseModule.forRoot(
          'mongodb://localhost:27017/wgo_post_views_integration?replicaSet=rs0',
        ),
        MongooseModule.forFeature([
          { name: 'Post', schema: PostSchema, collection: 'posts' },
          {
            name: 'Comment',
            schema: CommentSchema,
            collection: 'post_comments',
          },
          {
            name: 'Counter',
            schema: CounterSchema,
            collection: 'post_counters',
          },
          {
            name: 'DailyPostView',
            schema: DailyPostViewSchema,
            collection: 'post_daily_views',
          },
        ]),
      ],
      controllers: [PostController, InternalPostController],
      providers: [
        MongoosePostViews,
        MongoosePostRead,
        { provide: PARTITION_STRATEGY, useClass: HashPartitionStrategy },
        {
          provide: ReadPosts,
          useFactory: (queries: MongoosePostRead) => new ReadPosts(queries),
          inject: [MongoosePostRead],
        },
        ...[
          CreatePost,
          CreateComment,
          CreateCommentReaction,
          CreateReaction,
          JoinPost,
          FindSimilarPosts,
          PostLifecycle,
          MongooseVote,
          MediaService,
          POST_STATE_QUERIES,
        ].map((provide) => ({ provide, useValue: {} })),
      ],
    }).compile();
    app = module.createNestApplication();
    app.useLogger(false);
    await app.init();
    db = app.get(getConnectionToken());
    posts = app.get(getModelToken('Post'));
    receipts = app.get(getModelToken('DailyPostView'));
    counters = app.get(getModelToken('Counter'));
    await Promise.all(Object.values(db.models).map((model) => model.init()));
  }, 30000);

  beforeEach(async () => {
    await Promise.all([
      posts.deleteMany({}),
      receipts.deleteMany({}),
      counters.deleteMany({}),
    ]);
    id = `post_${randomUUID()}`;
    await posts.create({
      postId: id,
      authorId: 3,
      title: 'Views',
      content: 'Details',
      category: 'NEWS',
      status: 'ACTIVE',
      locationSnapshot: { latitude: 37, longitude: 127 },
      radiusM: 150,
      counters: {
        viewCount: 0,
        commentCount: 0,
        reactionCount: 0,
        participantCount: 1,
      },
      createdAt,
      updatedAt: createdAt,
      expiresAt: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.stubEnv('NODE_ENV', 'test');
  });
  afterAll(async () => {
    await db?.dropDatabase();
    await app?.close();
    vi.unstubAllEnvs();
  });

  it('counts the author and each other user once while preserving post metadata', async () => {
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(1);
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(1);
    expect((await get(4).expect(200)).body.counters.viewCount).toBe(2);
    expect((await get().expect(200)).body.counters.viewCount).toBe(2);
    expect(await receipts.countDocuments()).toBe(2);
    const post = await posts.findOne({ postId: id }).lean();
    expect(post?.updatedAt).toEqual(createdAt);
    expect(post?.counters.viewCount).toBe(0);
  });

  it('changes the day at Korean midnight, not UTC midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T14:59:59.999Z'));
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(1);
    vi.setSystemTime(new Date('2026-11-06T15:00:00Z'));
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(2);
    vi.setSystemTime(new Date('2026-11-07T00:00:00Z'));
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(2);
    expect(
      (await receipts.find().sort({ day: 1 }).lean()).map((row) => row.day),
    ).toEqual(['2026-11-06', '2026-11-07']);
  });

  it('deduplicates concurrent views and preserves distinct users sharing one bucket', async () => {
    await Promise.all(Array.from({ length: 10 }, () => get(3).expect(200)));
    expect((await get().expect(200)).body.counters.viewCount).toBe(1);
    await Promise.all(
      Array.from({ length: 8 }, (_, i) => get(i + 4).expect(200)),
    );
    expect((await get().expect(200)).body.counters.viewCount).toBe(9);
    expect(await receipts.countDocuments()).toBe(9);
  });

  it('rolls back the receipt when counter persistence fails and permits a retry', async () => {
    const failure = vi
      .spyOn(counters, 'updateOne')
      .mockRejectedValueOnce(new Error('storage unavailable'));
    await get(3).expect(500);
    failure.mockRestore();
    expect(await receipts.countDocuments()).toBe(0);
    expect(await counters.countDocuments()).toBe(0);
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(1);
  });

  it('keeps the request day when a transaction retry crosses midnight', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-06T14:59:59.999Z'));
    vi.spyOn(counters, 'updateOne').mockImplementationOnce(() => {
      vi.setSystemTime(new Date('2026-11-06T15:00:00Z'));
      throw Object.assign(new Error('concurrent first counter'), {
        code: 11000,
        keyPattern: { postId: 1, bucketId: 1, metric: 1 },
      });
    });
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(1);
    expect((await receipts.findOne().lean())?.day).toBe('2026-11-06');
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(2);
  });

  it('preserves legacy counts and counts readable expired or closed posts', async () => {
    await posts.updateOne(
      { postId: id },
      {
        $set: {
          'counters.viewCount': 7,
          status: 'EXPIRED',
          closedAt: createdAt,
        },
      },
    );
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(8);
    expect((await get(3).expect(200)).body.counters.viewCount).toBe(8);
  });

  it('does not count anonymous, invalid, missing or deleted detail requests', async () => {
    await get().expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}?latitude=bad`)
      .set('x-user-id', '3')
      .expect(400);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/post_${randomUUID()}`)
      .set('x-user-id', '3')
      .expect(404);
    await posts.updateOne({ postId: id }, { $set: { status: 'DELETED' } });
    await get(3).expect(404);
    expect(await receipts.countDocuments()).toBe(0);
    expect(await counters.countDocuments()).toBe(0);
  });

  it('leaves media and internal shared reads uncounted', async () => {
    await request(app.getHttpServer())
      .head(`/api/v1/posts/${id}`)
      .set('x-user-id', '3')
      .expect(200);
    await request(app.getHttpServer())
      .get(`/api/v1/posts/${id}/media`)
      .set('x-user-id', '3')
      .expect(200);
    await app.get(ReadPosts).detail(id, 3);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'HS256', typ: 'JWT' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'wgo-ws-gateway',
        sub: 'ws-gateway',
        aud: 'wgo-post-service',
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url');
    const secret = 'views-internal-test-secret-at-least-32';
    vi.stubEnv('WS_SERVICE_JWT_SECRET', secret);
    const signature = createHmac('sha256', secret)
      .update(`${header}.${payload}`)
      .digest('base64url');
    await request(app.getHttpServer())
      .get(`/internal/v1/posts/${id}`)
      .set('authorization', `Bearer ${header}.${payload}.${signature}`)
      .expect(200);
    await request(app.getHttpServer())
      .post('/internal/v1/posts/batch-get')
      .send({ postIds: [id] })
      .expect(201);
    expect(await receipts.countDocuments()).toBe(0);
  });

  it('requires a signed gateway identity in production before counting', async () => {
    const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
    vi.stubEnv(
      'POST_HTTP_GATEWAY_TRUSTED_JWKS',
      JSON.stringify({
        keys: [
          {
            ...keys.publicKey.export({ format: 'jwk' }),
            kid: 'views',
            alg: 'ES256',
            iss: 'wgo-http-gateway',
          },
        ],
      }),
    );
    vi.stubEnv('NODE_ENV', 'production');
    await get(3).expect(401);
    await get().expect(401);
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'ES256', typ: 'wgo-service+jwt', kid: 'views' }),
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: 'wgo-http-gateway',
        sub: 'http-gateway',
        aud: 'wgo-post-service',
        userId: '3',
        iat: now,
        exp: now + 30,
      }),
    ).toString('base64url');
    const signature = sign('sha256', Buffer.from(`${header}.${payload}`), {
      key: keys.privateKey,
      dsaEncoding: 'ieee-p1363',
    }).toString('base64url');
    const token = `Bearer ${header}.${payload}.${signature}`;
    await get(4).set('authorization', token).expect(401);
    expect(await receipts.countDocuments()).toBe(0);
    expect(
      (await get(3).set('authorization', token).expect(200)).body.counters
        .viewCount,
    ).toBe(1);
  });
});
