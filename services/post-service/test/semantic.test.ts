import { randomUUID } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createPost } from '../src/post/domain/post.js';
import {
  content,
  validateEmbedding,
  type SourcePost,
} from '../src/post/semantic/policy.js';
import {
  createEmbeddingProvider,
  type NearbyPostCandidates,
  type EmbeddingProvider,
  type SemanticPostIndex,
  type SemanticSource,
} from '../src/post/semantic/ports.js';
import { FindSimilarPosts } from '../src/post/semantic/search.js';
import {
  IndexSemanticPost,
  semanticEvent,
} from '../src/post/semantic/index-post.js';
import {
  SemanticConsumer,
  SemanticWorker,
  type SemanticRedis,
} from '../src/post/semantic/worker.js';
import { ElasticsearchIndex } from '../src/post/semantic/elasticsearch.js';
import { rebuildSemanticIndex } from '../src/post/semantic/rebuild.js';

import { draft, vector, fixtureEmbedding } from './fixtures/semantic.js';
const post = (i: number): SourcePost =>
  createPost(
    draft,
    123,
    `post_00000000-0000-0000-0000-${String(i).padStart(12, '0')}`,
    new Date(),
  );

describe('semantic search policy', () => {
  let posts: SourcePost[];
  let source: SemanticSource;
  let embedding: EmbeddingProvider;
  let index: SemanticPostIndex;
  let nearby: {
    search: ReturnType<typeof vi.fn<NearbyPostCandidates['search']>>;
  };
  const auth = {
    assertCanCreate: vi.fn(async () => {}),
    assertCanJoin: vi.fn(async () => {}),
  };
  const search = (threshold: number | undefined = 0.7) =>
    new FindSimilarPosts(auth, nearby, source, embedding, index, threshold);
  beforeEach(() => {
    vi.clearAllMocks();
    posts = Array.from({ length: 200 }, (_, i) => post(i));
    source = {
      batch: vi.fn(async (ids) => posts.filter((p) => ids.includes(p.postId))),
      async *scan() {
        yield* posts;
      },
    };
    embedding = fixtureEmbedding();
    nearby = {
      search: vi.fn(async () => ({
        items: posts.map((p, i) => ({ postId: p.postId, distanceM: i / 2 })),
        truncated: false,
      })),
    };
    index = {
      get: vi.fn(),
      put: vi.fn(),
      remove: vi.fn(),
      search: vi.fn(async (ids) =>
        posts
          .filter((p) => ids.includes(p.postId))
          .map((p, i) => ({
            postId: p.postId,
            contentHash: content(p).hash,
            embeddingVersion: 'v1',
            similarity: i === 199 ? 0.99 : 0.8,
          })),
      ),
    };
  });
  it('ranks candidate 200 first, defaults to five and returns one in the same array', async () => {
    const result = await search().execute(draft, 123);
    expect(result.items).toHaveLength(5);
    expect(result.items[0]!.postId).toBe(posts[199]!.postId);
    expect(result.checkStatus).toBe('completed');
    expect(
      (await search().execute({ ...draft, limit: 1 }, 123)).items,
    ).toHaveLength(1);
    expect(auth.assertCanCreate).toHaveBeenCalledWith(123, 37.5, 127, 250);
  });
  it('sorts ties by distance then postId and excludes injected outside candidates', async () => {
    nearby.search.mockResolvedValue({
      items: posts
        .slice(0, 3)
        .reverse()
        .map((p) => ({ postId: p.postId, distanceM: 10 })),
      truncated: false,
    });
    vi.mocked(index.search).mockResolvedValue(
      [posts[2]!, posts[1]!, posts[0]!, post(999)].map((p) => ({
        postId: p.postId,
        contentHash: content(p).hash,
        embeddingVersion: 'v1',
        similarity: 0.8,
      })),
    );
    expect(
      (await search().execute(draft, 123)).items.map((p) => p.postId),
    ).toEqual(posts.slice(0, 3).map((p) => p.postId));
  });
  it('does not embed or call ES without eligible candidates', async () => {
    for (const p of posts) p.status = 'DELETED';
    expect((await search().execute(draft, 123)).items).toEqual([]);
    expect(embedding.embed).not.toHaveBeenCalled();
    expect(index.search).not.toHaveBeenCalled();
  });
  it('returns complete empty results when scores are below the threshold', async () => {
    const result = await search(1).execute(draft, 123);
    expect(result).toMatchObject({
      items: [],
      checkStatus: 'completed',
      partialReasons: [],
    });
  });

  it('filters status, expiry, old/future source before search and does not filter category', async () => {
    posts[0]!.status = 'DELETED';
    posts[1]!.expiresAt = new Date(0);
    posts[2]!.createdAt = new Date(0);
    posts[3]!.createdAt = new Date(Date.now() + 60000);
    posts[4]!.category = 'GENERAL';
    await search().execute(draft, 123);
    expect(vi.mocked(index.search).mock.calls[0]![0]).toEqual(
      posts.slice(4).map((p) => p.postId),
    );
  });
  it('marks missing/wrong-version/stale hashes and candidate truncation as partial', async () => {
    nearby.search.mockResolvedValue({
      items: posts.slice(0, 3).map((p) => ({ postId: p.postId, distanceM: 0 })),
      truncated: true,
    });
    vi.mocked(index.search).mockResolvedValue([
      {
        postId: posts[0]!.postId,
        contentHash: 'stale',
        embeddingVersion: 'v1',
        similarity: 1,
      },
      {
        postId: posts[1]!.postId,
        contentHash: content(posts[1]!).hash,
        embeddingVersion: 'v2',
        similarity: 1,
      },
    ]);
    expect(await search().execute(draft, 123)).toMatchObject({
      items: [],
      checkStatus: 'partial',
      partialReasons: ['CANDIDATE_LIMIT', 'INDEX_LAG'],
    });
  });
  it('rechecks source status and content after ES, before choosing top results', async () => {
    const original = index.search;
    index.search = vi.fn<SemanticPostIndex['search']>(async (...args) => {
      const hits = await original(...args);
      posts[199]!.status = 'DELETED';
      posts[0]!.content = 'changed';
      posts[1]!.expiresAt = new Date(0);
      return hits;
    });
    const result = await search().execute(draft, 123);
    expect(result.items).toHaveLength(5);
    expect(result.items[0]!.postId).toBe(posts[2]!.postId);
    expect(result.partialReasons).toContain('INDEX_LAG');
  });
  it('fails closed before Map when model or evaluated threshold is absent', async () => {
    embedding = createEmbeddingProvider();
    await expect(search().execute(draft, 123)).rejects.toThrow(
      'SIMILARITY_CHECK_UNAVAILABLE',
    );
    embedding = fixtureEmbedding();
    await expect(
      new FindSimilarPosts(
        auth,
        nearby,
        source,
        embedding,
        index,
        undefined,
      ).execute(draft, 123),
    ).rejects.toThrow('SIMILARITY_CHECK_UNAVAILABLE');
    expect(auth.assertCanCreate).not.toHaveBeenCalled();
    expect(nearby.search).not.toHaveBeenCalled();
  });
  it.each(['map', 'mongo', 'embedding', 'es'])(
    'returns unavailable for %s dependency failure',
    async (target) => {
      const failure = async () => {
        throw new Error('unavailable');
      };
      if (target === 'map') nearby.search.mockImplementation(failure);
      if (target === 'mongo') source.batch = failure;
      if (target === 'embedding') embedding.embed = failure;
      if (target === 'es') index.search = failure;
      await expect(search().execute(draft, 123)).rejects.toThrow(
        'SIMILARITY_CHECK_UNAVAILABLE',
      );
    },
  );
  it.each([
    [],
    Array(384).fill(0),
    [NaN, ...vector.slice(1)],
    [Infinity, ...vector.slice(1)],
    vector.slice(1),
  ])('rejects invalid vectors', (values) => {
    expect(() =>
      validateEmbedding({ vector: values, version: 'v1' }, 'v1'),
    ).toThrow();
  });
  it('rejects mismatched version and shares normalization/hash', () => {
    expect(() => validateEmbedding({ vector, version: 'v2' }, 'v1')).toThrow();
    expect(content({ title: 'Ａ  현장', content: '본문\n상황' })).toEqual(
      content({ title: 'A 현장', content: '본문 상황' }),
    );
  });
});

describe('semantic indexing recovery', () => {
  const source: SemanticSource = { batch: vi.fn(), async *scan() {} };
  const index: SemanticPostIndex = {
    get: vi.fn(),
    put: vi.fn(),
    remove: vi.fn(),
    search: vi.fn(),
  };
  let embedding: EmbeddingProvider;
  let indexing: IndexSemanticPost;
  beforeEach(() => {
    vi.resetAllMocks();
    embedding = fixtureEmbedding();
    indexing = new IndexSemanticPost(source, embedding, index);
    vi.mocked(source.batch).mockResolvedValue([post(1)]);
    vi.mocked(index.get).mockResolvedValue(null);
  });
  it('reuses an existing vector for duplicate delivery, but updates metadata', async () => {
    await indexing.execute(post(1).postId);
    const document = vi.mocked(index.put).mock.calls[0]![0];
    vi.mocked(index.get).mockResolvedValue(document);
    await indexing.execute(post(1).postId);
    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(index.put).toHaveBeenCalledTimes(2);
  });
  it.each(['missing', 'DELETED', 'EXPIRED', 'expiry'])(
    'removes %s source without restoring it',
    async (state) => {
      const p = post(1);
      if (state === 'DELETED' || state === 'EXPIRED') p.status = state;
      if (state === 'expiry') p.expiresAt = new Date(0);
      vi.mocked(source.batch).mockResolvedValue(state === 'missing' ? [] : [p]);
      await indexing.execute(p.postId);
      expect(index.remove).toHaveBeenCalled();
      expect(index.put).not.toHaveBeenCalled();
    },
  );
  it('does not start worker or mutate backfill when the model is unavailable', async () => {
    const absent = createEmbeddingProvider();
    const worker = new SemanticWorker(
      absent,
      new IndexSemanticPost(source, absent, index),
    );
    worker.onModuleInit();
    expect(worker.redis.isOpen).toBe(false);
    await worker.onModuleDestroy();
    await expect(
      rebuildSemanticIndex(
        source,
        absent,
        new ElasticsearchIndex(),
        {} as SemanticRedis,
      ),
    ).rejects.toThrow('did not start');
  });
  const entry = () => {
    const id = `evt_${randomUUID()}`;
    return {
      id: '1-0',
      message: {
        eventId: id,
        eventType: 'PostCreated',
        data: JSON.stringify({
          eventId: id,
          eventType: 'PostCreated',
          schemaVersion: 1,
          producer: 'post-service',
          aggregateId: post(1).postId,
          occurredAt: new Date().toISOString(),
          post: { postId: post(1).postId },
        }),
      },
    };
  };
  it('keeps pending after ES write/ACK failure then retries without recomputing', async () => {
    const redis = {
      xAck: vi
        .fn()
        .mockRejectedValueOnce(new Error('crash'))
        .mockResolvedValue(1),
      xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 1 }]),
    };
    const consumer = new SemanticConsumer(
      redis as unknown as SemanticRedis,
      indexing,
    );
    const e = entry();
    await consumer.process(e);
    vi.mocked(index.get).mockResolvedValue(
      vi.mocked(index.put).mock.calls[0]![0],
    );
    await consumer.process(e);
    expect(embedding.embed).toHaveBeenCalledTimes(1);
    expect(redis.xAck).toHaveBeenCalledTimes(2);
  });
  it('keeps pending until attempt five and never ACKs when dead letter fails', async () => {
    vi.mocked(index.put).mockRejectedValue(new Error('ES down'));
    const redis = {
      xAck: vi.fn(),
      xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 4 }]),
      xAdd: vi.fn().mockRejectedValue(new Error('DLQ down')),
    };
    const consumer = new SemanticConsumer(
      redis as unknown as SemanticRedis,
      indexing,
    );
    await consumer.process(entry());
    expect(redis.xAck).not.toHaveBeenCalled();
    expect(redis.xAdd).not.toHaveBeenCalled();
    redis.xPendingRange.mockResolvedValue([{ deliveriesCounter: 5 }]);
    await expect(consumer.process(entry())).rejects.toThrow('DLQ down');
    expect(redis.xAck).not.toHaveBeenCalled();
    redis.xAdd.mockResolvedValue('2-0');
    await consumer.process(entry());
    expect(redis.xAck).toHaveBeenCalledOnce();
  });
  it('ACKs unsupported events, and dead-letters malformed target events before ACK', async () => {
    const redis = {
      xAck: vi.fn(),
      xPendingRange: vi.fn().mockResolvedValue([{ deliveriesCounter: 1 }]),
      xAdd: vi.fn().mockResolvedValue('2-0'),
    };
    const consumer = new SemanticConsumer(
      redis as unknown as SemanticRedis,
      indexing,
    );
    await consumer.process({
      id: '1-0',
      message: { eventType: 'PostReactionCreated' },
    });
    expect(redis.xAck).toHaveBeenCalledOnce();
    expect(index.put).not.toHaveBeenCalled();
    await consumer.process({
      id: '2-0',
      message: { eventType: 'PostCreated', data: 'bad' },
    });
    expect(redis.xAdd).toHaveBeenCalledWith(
      consumer.deadStream,
      '*',
      expect.objectContaining({ streamId: '2-0' }),
    );
    expect(redis.xAck).toHaveBeenCalledTimes(2);
    expect(redis.xAdd.mock.invocationCallOrder[0]).toBeLessThan(
      redis.xAck.mock.invocationCallOrder[1]!,
    );
  });

  it('ignores unsupported events but rejects corrupt target envelope', () => {
    expect(semanticEvent({ eventType: 'PostReactionCreated' })).toBeNull();
    const e = entry();
    expect(semanticEvent(e.message)).toBe(post(1).postId);
    for (const patch of [
      { producer: 'map-service' },
      { schemaVersion: 2 },
      { eventId: 'bad' },
      { aggregateId: 'bad' },
    ]) {
      expect(() =>
        semanticEvent({
          ...e.message,
          data: JSON.stringify({ ...JSON.parse(e.message.data), ...patch }),
        }),
      ).toThrow('Invalid');
    }
  });
});
