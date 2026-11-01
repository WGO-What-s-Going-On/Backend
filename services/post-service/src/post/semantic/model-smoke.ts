import 'reflect-metadata';
import assert from 'node:assert/strict';
import { E5EmbeddingProvider } from './embedding-provider.js';

const provider = new E5EmbeddingProvider();
const started = performance.now();
try {
  await provider.initialize();
  assert.equal(provider.ready, true, 'Model did not finish warmup');
  const first = await provider.embed(
    '강남역 도로에서 교통사고가 발생했습니다.',
    AbortSignal.timeout(10000),
  );
  const repeated = await provider.embed(
    '강남역 도로에서 교통사고가 발생했습니다.',
    AbortSignal.timeout(10000),
  );
  assert.equal(first.vector.length, 384);
  assert.equal(first.vector.every(Number.isFinite), true);
  assert.ok(Math.abs(Math.hypot(...first.vector) - 1) < 0.000001);
  assert.deepEqual(first, repeated);
  process.stdout.write(
    JSON.stringify({
      model: first.version,
      architecture: process.arch,
      elapsedMs: Math.round(performance.now() - started),
      rssBytes: process.memoryUsage().rss,
      ready: provider.ready,
      dimensions: first.vector.length,
    }) + '\n',
  );
} finally {
  await provider.close();
}
