import { createHash } from 'node:crypto';
import type { PostRecord } from '../domain/post.js';

export const DIMENSIONS = 384;
export const CANDIDATE_LIMIT = 200;
export const SCOPE = { radiusM: 150, lookbackHours: 24 } as const;
export type SourcePost = Pick<
  PostRecord,
  | 'postId'
  | 'title'
  | 'content'
  | 'category'
  | 'status'
  | 'createdAt'
  | 'updatedAt'
  | 'expiresAt'
>;
export type Embedding = { vector: number[]; version: string };

export function content(post: Pick<SourcePost, 'title' | 'content'>) {
  const normalize = (value: string) =>
    value.normalize('NFKC').replace(/\s+/gu, ' ').trim();
  const text = `${normalize(post.title)}\n${normalize(post.content)}`;
  return { text, hash: createHash('sha256').update(text).digest('hex') };
}

export function validateEmbedding(value: Embedding, version: string): number[] {
  if (
    value.version !== version ||
    !Array.isArray(value.vector) ||
    value.vector.length !== DIMENSIONS ||
    !Array.from(value.vector).every(Number.isFinite) ||
    !value.vector.some((v) => v !== 0) ||
    !Number.isFinite(Math.hypot(...value.vector))
  )
    throw new Error('Invalid embedding or version');
  return value.vector;
}

export function active(post: SourcePost, now: Date): boolean {
  return post.status === 'ACTIVE' && (!post.expiresAt || post.expiresAt > now);
}
export function eligible(post: SourcePost, now: Date): boolean {
  return (
    active(post, now) &&
    post.createdAt <= now &&
    post.createdAt.getTime() >= now.getTime() - SCOPE.lookbackHours * 3600000
  );
}

export class SimilarityUnavailableError extends Error {
  constructor() {
    super('SIMILARITY_CHECK_UNAVAILABLE');
  }
}
