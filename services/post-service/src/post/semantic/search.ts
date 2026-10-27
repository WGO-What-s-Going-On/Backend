import { createPost, type PostInput } from '../domain/post.js';
import { LocationDeniedError } from '../application/errors.js';
import type { LocationAuthorization } from '../application/ports.js';
import type {
  EmbeddingProvider,
  NearbyPostCandidates,
  SemanticSource,
  SemanticPostIndex,
} from './ports.js';
import {
  CANDIDATE_LIMIT,
  SCOPE,
  content,
  eligible,
  validateEmbedding,
  SimilarityUnavailableError,
} from './policy.js';

export class FindSimilarPosts {
  constructor(
    private readonly authorization: LocationAuthorization,
    private readonly candidates: NearbyPostCandidates,
    private readonly source: SemanticSource,
    private readonly embedding: EmbeddingProvider,
    private readonly index: SemanticPostIndex,
    private readonly threshold: number | undefined,
    private readonly enabled = true,
  ) {}

  async execute(input: PostInput & { limit: number }, userId: number) {
    // 생성과 같은 도메인 검증을 거치지만 원본이나 Outbox는 저장하지 않는다.
    createPost(input, userId, 'draft', new Date());
    if (
      !this.enabled ||
      !this.embedding.ready ||
      this.threshold === undefined ||
      !Number.isFinite(this.threshold) ||
      this.threshold < -1 ||
      this.threshold > 1
    )
      throw new SimilarityUnavailableError();
    const signal = AbortSignal.timeout(10000);
    try {
      return await deadline(this.search(input, userId, signal), signal);
    } catch (error) {
      if (error instanceof LocationDeniedError) throw error;
      throw new SimilarityUnavailableError();
    }
  }

  private async search(
    input: PostInput & { limit: number },
    userId: number,
    signal: AbortSignal,
  ) {
    await this.authorization.assertCanCreate(
      userId,
      input.latitude,
      input.longitude,
      input.radiusM,
    );
    signal.throwIfAborted();
    const nearby = await this.candidates.search(
      input.latitude,
      input.longitude,
    );
    if (
      nearby.items.length > CANDIDATE_LIMIT ||
      typeof nearby.truncated !== 'boolean' ||
      new Set(nearby.items.map((p) => p.postId)).size !== nearby.items.length ||
      nearby.items.some(
        (p) =>
          !/^post_[0-9a-f-]{36}$/.test(p.postId) ||
          !Number.isFinite(p.distanceM) ||
          p.distanceM < 0 ||
          p.distanceM > SCOPE.radiusM,
      )
    )
      throw new Error('Invalid Map candidates');
    const now = new Date();
    const reasons = new Set<'CANDIDATE_LIMIT' | 'INDEX_LAG'>();
    if (nearby.truncated) reasons.add('CANDIDATE_LIMIT');
    const distances = new Map(nearby.items.map((p) => [p.postId, p.distanceM]));
    const posts = nearby.items.length
      ? (await this.source.batch([...distances.keys()])).filter(
          (p) => distances.has(p.postId) && eligible(p, now),
        )
      : [];
    const respond = (
      items: {
        postId: string;
        title: string;
        excerpt: string;
        category: string;
        distanceM: number;
        createdAt: string;
      }[],
    ) => ({
      items,
      checkStatus: reasons.size ? 'partial' : 'completed',
      partialReasons: [...reasons],
      scope: SCOPE,
      checkedAt: new Date().toISOString(),
    });
    if (!posts.length) return respond([]);
    signal.throwIfAborted();
    const vector = await this.embedding.embed(content(input).text, signal);
    validateEmbedding(vector, this.embedding.version);
    signal.throwIfAborted();
    // 모든 후보를 검색해야 낮은 점수와 인덱스 누락을 구분하고 최종 탈락분을 보충할 수 있다.
    const hits = await this.index.search(
      posts.map((p) => p.postId),
      vector,
      now,
      signal,
    );
    const candidateIds = new Set(posts.map((p) => p.postId));
    const validHits = hits.filter(
      (h) =>
        candidateIds.has(h.postId) &&
        h.embeddingVersion === this.embedding.version,
    );
    const hitIds = new Set(validHits.map((h) => h.postId));
    if (posts.some((p) => !hitIds.has(p.postId))) reasons.add('INDEX_LAG');
    const latest = new Map(
      (await this.source.batch(posts.map((p) => p.postId))).map((p) => [
        p.postId,
        p,
      ]),
    );
    const checked = new Date();
    const ranked = validHits.flatMap((hit) => {
      const post = latest.get(hit.postId);
      if (!post || !eligible(post, checked)) return [];
      if (content(post).hash !== hit.contentHash) {
        reasons.add('INDEX_LAG');
        return [];
      }
      if (!Number.isFinite(hit.similarity))
        throw new Error('Invalid similarity score');
      if (hit.similarity < this.threshold!) return [];
      return [
        {
          post,
          similarity: hit.similarity,
          distanceM: distances.get(post.postId)!,
        },
      ];
    });
    ranked.sort(
      (a, b) =>
        b.similarity - a.similarity ||
        a.distanceM - b.distanceM ||
        (a.post.postId < b.post.postId
          ? -1
          : a.post.postId > b.post.postId
            ? 1
            : 0),
    );
    signal.throwIfAborted();
    return respond(
      ranked.slice(0, input.limit).map(({ post, distanceM }) => ({
        postId: post.postId,
        title: post.title,
        excerpt: [...post.content].slice(0, 160).join(''),
        category: post.category,
        distanceM,
        createdAt: post.createdAt.toISOString(),
      })),
    );
  }
}

async function deadline<T>(
  operation: Promise<T>,
  signal: AbortSignal,
): Promise<T> {
  signal.throwIfAborted();
  let abort!: () => void;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        abort = () => reject(signal.reason);
        signal.addEventListener('abort', abort, { once: true });
      }),
    ]);
  } finally {
    signal.removeEventListener('abort', abort);
  }
}
