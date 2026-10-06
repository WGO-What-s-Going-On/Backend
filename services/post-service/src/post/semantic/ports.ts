import type { Embedding, SourcePost } from './policy.js';

export interface EmbeddingProvider {
  readonly ready: boolean;
  readonly version: string;
  embed(text: string, signal: AbortSignal): Promise<Embedding>;
}
export interface NearbyPostCandidates {
  search(
    latitude: number,
    longitude: number,
  ): Promise<{
    items: { postId: string; distanceM: number }[];
    truncated: boolean;
  }>;
}
export interface SemanticSource {
  batch(ids: string[]): Promise<SourcePost[]>;
  scan(): AsyncIterable<SourcePost>;
}
export interface SemanticDocument {
  postId: string;
  status: string;
  category: string;
  createdAt: string;
  expiresAt: string | null;
  sourceUpdatedAt: string;
  indexedAt: string;
  contentHash: string;
  embeddingVersion: string;
  embedding: number[];
}
export type SemanticHit = {
  postId: string;
  contentHash: string;
  embeddingVersion: string;
  similarity: number;
};
export interface SemanticPostIndex {
  get(id: string, signal: AbortSignal): Promise<SemanticDocument | null>;
  put(document: SemanticDocument, signal: AbortSignal): Promise<void>;
  remove(id: string, signal: AbortSignal): Promise<void>;
  search(
    ids: string[],
    embedding: Embedding,
    now: Date,
    signal: AbortSignal,
  ): Promise<SemanticHit[]>;
}
export const EMBEDDING_PROVIDER = Symbol('EMBEDDING_PROVIDER');
export const NEARBY_POST_CANDIDATES = Symbol('NEARBY_POST_CANDIDATES');
export const SEMANTIC_SOURCE = Symbol('SEMANTIC_SOURCE');
export const SEMANTIC_POST_INDEX = Symbol('SEMANTIC_POST_INDEX');

// 운영에서 fixture를 선택하는 설정 경로는 두지 않는다. 모델 연결 시 이 factory를 교체한다.
export function createEmbeddingProvider(): EmbeddingProvider {
  return {
    ready: false,
    version: 'v1',
    async embed() {
      throw new Error('Embedding model is not connected');
    },
  };
}
