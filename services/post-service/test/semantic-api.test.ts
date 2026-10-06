import { PostLifecycle } from '../src/post/application/lifecycle.js';
import { Test } from '@nestjs/testing';
import type { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { PostController } from '../src/post/post.controller.js';
import {
  CreateComment,
  CreatePost,
  CreateReaction,
  JoinPost,
} from '../src/post/application/commands.js';
import { ReadPosts } from '../src/post/application/queries.js';
import { FindSimilarPosts } from '../src/post/semantic/search.js';
import { E5EmbeddingProvider } from '../src/post/semantic/embedding-provider.js';
import { type SemanticPostIndex } from '../src/post/semantic/ports.js';
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
          PostLifecycle,
          CreatePost,
          CreateComment,
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
  it('returns 200 with default limit five and empty result without saving', async () => {
    const usecase = new FindSimilarPosts(
      auth,
      nearby,
      source,
      fixtureEmbedding(),
      index,
      0.7,
    );
    execute.mockImplementation(usecase.execute.bind(usecase));
    const { limit: _, ...body } = draft;
    const response = await run(body).expect(200);
    expect(execute.mock.lastCall?.[0].limit).toBe(5);
    expect(response.body).toMatchObject({
      items: [],
      checkStatus: 'completed',
      partialReasons: [],
      scope: { radiusM: 150, lookbackHours: 24 },
    });
  });
  it.each([0, 11, 1.5, '1', null])(
    'rejects invalid limit %s',
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
      undefined,
    );
    execute.mockImplementation(usecase.execute.bind(usecase));
    await run(draft, '').expect(403);
    await run({ ...draft, latitude: 91 }).expect(400);
    await run({ ...draft, title: '' }).expect(400);
    const response = await run(draft).expect(503);
    expect(response.body.code).toBe('SIMILARITY_CHECK_UNAVAILABLE');
  });
});
