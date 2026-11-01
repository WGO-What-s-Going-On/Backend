import { createServer, type Server } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
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
  let responseDelayMs = 0;
  beforeAll(async () => {
    server = createServer(async (req, res) => {
      let raw = '';
      for await (const chunk of req) raw += chunk;
      body = JSON.parse(raw || '{}');
      await delay(responseDelayMs);
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
      2000,
    );
  });
  beforeEach(() => {
    responseDelayMs = 0;
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
      AbortSignal.timeout(4000),
    );
  it('filters IDs, version, state and time internally and restores cosine score', async () => {
    // CI scheduling can exceed the old 100 ms budget without an HTTP failure.
    responseDelayMs = 150;
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
});

// Keep the short deadline confined to a server that intentionally never responds.
it('enforces an HTTP timeout after the server receives the request', async () => {
  let receivedRequest = false;
  const server = createServer((req) => {
    receivedRequest = true;
    req.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();
    if (!address || typeof address === 'string')
      throw new Error('Missing server port');
    const index = new ElasticsearchIndex(
      'post-test',
      `http://127.0.0.1:${address.port}`,
      500,
    );
    const signal = AbortSignal.timeout(4000);
    await expect(
      index.search(['post_1'], { vector, version: 'v1' }, new Date(), signal),
    ).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(receivedRequest).toBe(true);
    expect(signal.aborted).toBe(false);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
