import { createServer, type Server } from 'node:http';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  ElasticsearchIndex,
  mapping,
} from '../src/post/semantic/elasticsearch.js';
import { vector } from './fixtures/semantic.js';

describe('Elasticsearch HTTP boundary', () => {
  let server: Server;
  let index: ElasticsearchIndex;
  let body: any;
  let response: any;
  let timeout = false;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || '{}');
      if (timeout) return;
      res
        .writeHead(200, { 'content-type': 'application/json' })
        .end(JSON.stringify(response));
    });
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    index = new ElasticsearchIndex(
      'post-test',
      `http://127.0.0.1:${(server.address() as { port: number }).port}`,
      100,
    );
  });
  afterAll(async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  const search = () =>
    index.search(
      ['post_1'],
      { vector, version: 'v1' },
      new Date(),
      AbortSignal.timeout(1000),
    );
  it('filters IDs, version, state and time internally and restores cosine score', async () => {
    response = {
      timed_out: false,
      _shards: { failed: 0 },
      hits: {
        hits: [
          {
            _id: 'post_1',
            _score: 1.8,
            _source: {
              postId: 'post_1',
              contentHash: 'hash',
              embeddingVersion: 'v1',
            },
          },
        ],
      },
    };
    expect((await search())[0]!.similarity).toBeCloseTo(0.8);
    expect(body.size).toBe(1);
    expect(body.query.script_score.query.bool.filter).toEqual(
      expect.arrayContaining([
        { terms: { postId: ['post_1'] } },
        { term: { embeddingVersion: 'v1' } },
        { term: { status: 'ACTIVE' } },
      ]),
    );
    expect(body.query.script_score.script.source).toBe(
      "cosineSimilarity(params.vector, 'embedding') + 1.0",
    );
    expect(mapping.properties.embedding).toMatchObject({
      dims: 384,
      index: false,
    });
  });
  it.each([
    { timed_out: true, _shards: { failed: 0 } },
    { timed_out: false, _shards: { failed: 1 } },
  ])('rejects incomplete searches', async (partial) => {
    response = { ...partial, hits: { hits: [] } };
    await expect(search()).rejects.toThrow('Incomplete');
  });
  it('enforces an HTTP timeout', async () => {
    timeout = true;
    await expect(search()).rejects.toThrow();
  });
});
