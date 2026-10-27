import type {
  EmbeddingProvider,
  SemanticPostIndex,
  SemanticSource,
} from './ports.js';
import { active, content, validateEmbedding } from './policy.js';

export class IndexSemanticPost {
  constructor(
    readonly source: SemanticSource,
    readonly embedding: EmbeddingProvider,
    readonly index: SemanticPostIndex,
  ) {}
  async execute(id: string, signal = AbortSignal.timeout(10000)) {
    if (!this.embedding.ready)
      throw new Error('Embedding model is not connected');
    const post = (await this.source.batch([id]))[0];
    signal.throwIfAborted();
    if (!post || !active(post, new Date())) {
      await this.index.remove(id, signal);
      return;
    }
    const normalized = content(post);
    const existing = await this.index.get(id, signal);
    const embedding =
      existing?.contentHash === normalized.hash &&
      existing.embeddingVersion === this.embedding.version
        ? { vector: existing.embedding, version: existing.embeddingVersion }
        : await this.embedding.embed(normalized.text, signal, 'background');
    validateEmbedding(embedding, this.embedding.version);
    // 모델 계산 중 삭제·만료되거나 본문이 바뀌면 이전 스냅샷을 저장하지 않는다.
    const latest = (await this.source.batch([id]))[0];
    signal.throwIfAborted();
    if (!latest || !active(latest, new Date())) {
      await this.index.remove(id, signal);
      return;
    }
    if (content(latest).hash !== normalized.hash)
      throw new Error('Post changed during embedding');
    await this.index.put(
      {
        postId: id,
        status: latest.status,
        category: latest.category,
        createdAt: latest.createdAt.toISOString(),
        expiresAt: latest.expiresAt?.toISOString() ?? null,
        sourceUpdatedAt: latest.updatedAt.toISOString(),
        indexedAt: new Date().toISOString(),
        contentHash: normalized.hash,
        embeddingVersion: embedding.version,
        embedding: embedding.vector,
      },
      signal,
    );
  }
}

export class InvalidSemanticEvent extends Error {}
export function semanticEvent(fields: Record<string, string>): string | null {
  const supported = ['PostCreated', 'PostExpired', 'PostDeleted'];
  if (fields.eventType && !supported.includes(fields.eventType)) return null;
  try {
    const value = JSON.parse(fields.data ?? '');
    const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
    if (
      !value ||
      !supported.includes(value.eventType) ||
      value.eventType !== fields.eventType ||
      value.eventId !== fields.eventId ||
      !new RegExp(`^evt_${uuid}$`).test(value.eventId) ||
      !new RegExp(`^post_${uuid}$`).test(value.aggregateId) ||
      value.producer !== 'post-service' ||
      value.schemaVersion !== 1 ||
      typeof value.occurredAt !== 'string' ||
      !Number.isFinite(Date.parse(value.occurredAt)) ||
      (value.eventType === 'PostCreated' &&
        value.post?.postId !== value.aggregateId)
    )
      throw new Error();
    return value.aggregateId as string;
  } catch {
    throw new InvalidSemanticEvent('Invalid semantic event envelope');
  }
}
