import { MediaService } from '../src/post/media/media.service.js';
import { POST_STATE_QUERIES } from '../src/post/application/ports.js';
import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { MongooseVote } from '../src/post/infrastructure/mongoose-vote.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostController } from '../src/post/post.controller.js';
import {
  CreateComment,
  CreateCommentReaction,
  CreatePost,
  CreateReaction,
  JoinPost,
} from '../src/post/application/commands.js';
import { ReadPosts } from '../src/post/application/queries.js';
import { FindSimilarPosts } from '../src/post/semantic/search.js';
import { E5EmbeddingProvider } from '../src/post/semantic/embedding-provider.js';
import { type SemanticPostIndex } from '../src/post/semantic/ports.js';
import { createPost } from '../src/post/domain/post.js';
import { content } from '../src/post/semantic/policy.js';
import { draft, fixtureEmbedding } from './fixtures/semantic.js';

const auth = {
  assertCanCreate: vi.fn(async () => {}),
  assertCanJoin: vi.fn(async () => {}),
};
const nearby = { search: vi.fn(async () => ({ items: [], truncated: false })) };
const source = { batch: vi.fn(async () => []), async *scan() {} };
const index = {
  get: vi.fn(),
  put: vi.fn(),
  remove: vi.fn(),
  search: vi.fn(),
} satisfies SemanticPostIndex;

describe('similar HTTP contract', () => {
  let app: INestApplication;
  const execute = vi.fn();
  beforeAll(async () => {
    const module = await Test.createTestingModule({
      controllers: [PostController],
      providers: [
        ...[
          MediaService,
          POST_STATE_QUERIES,
          PostLifecycle,
          MongooseVote,
          CreatePost,
          CreateComment,
          CreateCommentReaction,
          CreateReaction,
          JoinPost,
          ReadPosts,
        ].map((provide) => ({ provide, useValue: {} })),
        { provide: FindSimilarPosts, useValue: { execute } },
      ],
    }).compile();
    app = module.createNestApplication();
    await app.init();
  });
  afterAll(async () => {
    await app.close();
  });
  const run = (body: object, header = '123') =>
    request(app.getHttpServer())
      .post('/api/v1/posts/similar')
      .set('X-User-Id', header)
      .send(body);
  it('returns 200 with empty result without saving', async () => {
    const usecase = new FindSimilarPosts(
      auth,
      nearby,
      source,
      fixtureEmbedding(),
      index,
    );
    execute.mockImplementation(usecase.execute.bind(usecase));
    const response = await run(draft).expect(200);
    expect(execute.mock.lastCall?.[0]).not.toHaveProperty('limit');
    expect(response.body).toMatchObject({
      items: [],
      checkStatus: 'completed',
      partialReasons: [],
      scope: { radiusM: 150, lookbackHours: 24 },
    });
  });
  it('returns three ranked items with display percentages over HTTP', async () => {
    const posts = Array.from({ length: 4 }, (_, i) =>
      createPost(
        draft,
        123,
        `post_00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
        new Date(),
      ),
    );
    const usecase = new FindSimilarPosts(
      auth,
      {
        search: async () => ({
          items: posts.map((p) => ({ postId: p.postId, distanceM: 1 })),
          truncated: false,
        }),
      },
      { batch: async () => posts, async *scan() {} },
      fixtureEmbedding(),
      {
        ...index,
        search: async () =>
          posts.map((p, i) => ({
            postId: p.postId,
            contentHash: content(p).hash,
            embeddingVersion: 'v1',
            similarity: [0.123456, 0.01, -0.1, -0.2][i]!,
          })),
      },
    );
    execute.mockImplementation(usecase.execute.bind(usecase));
    const response = await run(draft).expect(200);
    expect(
      response.body.items.map(
        (p: { similarityPercent: number }) => p.similarityPercent,
      ),
    ).toEqual([12.35, 1, 0]);
    expect(response.body.items[0]).toEqual({
      postId: posts[0]!.postId,
      title: draft.title,
      excerpt: draft.content,
      category: draft.category,
      distanceM: 1,
      similarityPercent: 12.35,
      createdAt: posts[0]!.createdAt.toISOString(),
    });
  });
  it.each([0, 1, 3, 5, 10, 11, 1.5, '1', null])(
    'rejects removed limit %s',
    async (limit) => {
      await run({ ...draft, limit }).expect(400);
    },
  );
  it.each(['candidateIds', 'vector', 'embeddingVersion', 'threshold'])(
    'rejects client-controlled %s',
    async (key) => {
      await run({ ...draft, [key]: [] }).expect(400);
    },
  );
  it('validates authentication and input before model readiness', async () => {
    const usecase = new FindSimilarPosts(
      auth,
      nearby,
      source,
      new E5EmbeddingProvider(false),
      index,
    );
    execute.mockImplementation(usecase.execute.bind(usecase));
    await run(draft, '').expect(403);
    await run({ ...draft, latitude: 91 }).expect(400);
    await run({ ...draft, title: '' }).expect(400);
    const response = await run(draft).expect(503);
    expect(response.body.code).toBe('SIMILARITY_CHECK_UNAVAILABLE');
  });
});
