import type { Embedding } from './policy.js';
import { E5_VERSION } from './model-artifacts.js';
import {
  CANDIDATE_LIMIT,
  DIMENSIONS,
  SCOPE,
  validateEmbedding,
} from './policy.js';
import type {
  SemanticDocument,
  SemanticHit,
  SemanticPostIndex,
} from './ports.js';

export const mapping = {
  dynamic: 'strict',
  properties: {
    ...Object.fromEntries(
      ['postId', 'status', 'category', 'contentHash', 'embeddingVersion'].map(
        (key) => [key, { type: 'keyword' }],
      ),
    ),
    ...Object.fromEntries(
      ['createdAt', 'expiresAt', 'sourceUpdatedAt', 'indexedAt'].map((key) => [
        key,
        { type: 'date' },
      ]),
    ),
    embedding: { type: 'dense_vector', dims: DIMENSIONS, index: false },
  },
};
export class ElasticsearchIndex implements SemanticPostIndex {
  constructor(
    readonly target = process.env.SEMANTIC_INDEX_ALIAS ??
      `post-semantic-${E5_VERSION}-read`,
    private readonly url = process.env.ELASTICSEARCH_URL ??
      'http://localhost:9200',
    private readonly timeoutMs = Number(
      process.env.ELASTICSEARCH_TIMEOUT_MS ?? 2000,
    ),
    private readonly alias = true,
  ) {
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(target))
      throw new Error('Invalid semantic index name');
  }
  at(target: string) {
    return new ElasticsearchIndex(target, this.url, this.timeoutMs, false);
  }
  async request<T>(
    method: string,
    path: string,
    body?: unknown,
    signal?: AbortSignal,
    allowMissing = false,
  ): Promise<T> {
    if (
      !Number.isInteger(this.timeoutMs) ||
      this.timeoutMs < 1 ||
      this.timeoutMs > 10000
    )
      throw new Error('Invalid Elasticsearch timeout');
    const deadline = AbortSignal.timeout(this.timeoutMs);
    const response = await fetch(`${this.url}/${path}`, {
      method,
      headers: {
        'content-type': 'application/json',
        ...(process.env.ELASTICSEARCH_API_KEY
          ? { authorization: `ApiKey ${process.env.ELASTICSEARCH_API_KEY}` }
          : {}),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, deadline]) : deadline,
    });
    if (allowMissing && response.status === 404) return null as T;
    if (!response.ok) throw new Error(`Elasticsearch ${response.status}`);
    return response.json() as Promise<T>;
  }
  async get(id: string, signal: AbortSignal) {
    const result = await this.request<{ _source: SemanticDocument } | null>(
      'GET',
      `${this.target}/_doc/${encodeURIComponent(id)}`,
      undefined,
      signal,
      true,
    );
    return result?._source ?? null;
  }
  async put(document: SemanticDocument, signal: AbortSignal) {
    validateEmbedding(
      { vector: document.embedding, version: document.embeddingVersion },
      document.embeddingVersion,
    );
    signal.throwIfAborted();
    // 별칭 초기화 누락이 벡터 mapping 없는 동적 인덱스를 만들지 않게 한다.
    await this.request(
      'PUT',
      `${this.target}/_doc/${encodeURIComponent(document.postId)}${this.alias ? '?require_alias=true' : ''}`,
      document,
      signal,
    );
  }
  async remove(id: string, signal: AbortSignal) {
    signal.throwIfAborted();
    await this.request(
      'DELETE',
      `${this.target}/_doc/${encodeURIComponent(id)}`,
      undefined,
      signal,
      true,
    );
  }
  async search(
    ids: string[],
    embedding: Embedding,
    now: Date,
    signal: AbortSignal,
  ): Promise<SemanticHit[]> {
    if (!ids.length) return [];
    if (ids.length > CANDIDATE_LIMIT)
      throw new Error('Too many semantic candidates');
    validateEmbedding(embedding, embedding.version);
    const result = await this.request<{
      timed_out: boolean;
      _shards: { failed: number };
      hits: {
        hits: {
          _id: string;
          _score: number;
          _source: Pick<
            SemanticDocument,
            'postId' | 'contentHash' | 'embeddingVersion'
          >;
        }[];
      };
    }>(
      'POST',
      `${this.target}/_search?allow_partial_search_results=false`,
      {
        size: ids.length,
        track_total_hits: true,
        _source: ['postId', 'contentHash', 'embeddingVersion'],
        query: {
          script_score: {
            query: {
              bool: {
                filter: [
                  { terms: { postId: ids } },
                  { term: { status: 'ACTIVE' } },
                  { term: { embeddingVersion: embedding.version } },
                  { exists: { field: 'embedding' } },
                  {
                    range: {
                      createdAt: {
                        gte: new Date(
                          now.getTime() - SCOPE.lookbackHours * 3600000,
                        ).toISOString(),
                        lte: now.toISOString(),
                      },
                    },
                  },
                  {
                    bool: {
                      minimum_should_match: 1,
                      should: [
                        {
                          bool: {
                            must_not: { exists: { field: 'expiresAt' } },
                          },
                        },
                        { range: { expiresAt: { gt: now.toISOString() } } },
                      ],
                    },
                  },
                ],
              },
            },
            script: {
              source: "cosineSimilarity(params.vector, 'embedding') + 1.0",
              params: { vector: embedding.vector },
            },
          },
        },
      },
      signal,
    );
    if (
      result.timed_out !== false ||
      result._shards?.failed !== 0 ||
      !Array.isArray(result.hits?.hits)
    )
      throw new Error('Incomplete Elasticsearch search');
    const seen = new Set<string>();
    return result.hits.hits.map((hit) => {
      if (
        !hit._source ||
        hit._id !== hit._source.postId ||
        !ids.includes(hit._id) ||
        seen.has(hit._id) ||
        !Number.isFinite(hit._score) ||
        hit._score < 0 ||
        hit._score > 2.000001
      )
        throw new Error('Invalid Elasticsearch hit');
      seen.add(hit._id);
      return {
        ...hit._source,
        similarity: Math.max(-1, Math.min(1, hit._score - 1)),
      };
    });
  }
  async create() {
    await this.request('PUT', this.target, {
      settings: { number_of_shards: 1, number_of_replicas: 0 },
      mappings: mapping,
    });
  }
  async refresh() {
    await this.request('POST', `${this.target}/_refresh`);
  }
  async switchAlias(alias: string) {
    if (!/^[a-z0-9][a-z0-9_-]+$/.test(alias) || alias === this.target)
      throw new Error('Invalid alias');
    const current = await this.request<Record<string, unknown> | null>(
      'GET',
      `_alias/${alias}`,
      undefined,
      undefined,
      true,
    );
    await this.request('POST', '_aliases', {
      actions: [
        ...Object.keys(current ?? {}).map((index) => ({
          remove: { index, alias, must_exist: true },
        })),
        { add: { index: this.target, alias, is_write_index: true } },
      ],
    });
  }
  async *documents(): AsyncIterable<SemanticDocument> {
    let after: unknown[] | undefined;
    while (true) {
      const result = await this.request<{
        timed_out: boolean;
        _shards: { failed: number };
        hits: { hits: { _source: SemanticDocument; sort: unknown[] }[] };
      }>('POST', `${this.target}/_search`, {
        size: 200,
        sort: [{ postId: 'asc' }],
        ...(after ? { search_after: after } : {}),
      });
      if (result.timed_out || result._shards.failed)
        throw new Error('Incomplete index validation');
      for (const hit of result.hits.hits) yield hit._source;
      if (result.hits.hits.length < 200) break;
      after = result.hits.hits.at(-1)!.sort;
    }
  }
}
