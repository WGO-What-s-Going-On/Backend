import { vi } from 'vitest';
import type { EmbeddingProvider } from '../../src/post/semantic/ports.js';
export const draft = {
  title: '현장',
  content: '현장 상황입니다',
  category: 'INCIDENT',
  latitude: 37.5,
  longitude: 127,
  radiusM: 250,
  limit: 5,
};
export const vector = [1, ...Array<number>(383).fill(0)];
export const fixtureEmbedding = (): EmbeddingProvider => ({
  ready: true,
  version: 'v1',
  embed: vi.fn(async () => ({ vector, version: 'v1' })),
});
