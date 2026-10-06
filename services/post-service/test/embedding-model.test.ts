import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { E5EmbeddingProvider } from '../src/post/semantic/embedding-provider.js';
import { loadE5Runtime } from '../src/post/semantic/e5-runtime.js';
import {
  artifactHash,
  E5_VERSION,
  modelPath,
} from '../src/post/semantic/model-artifacts.js';
import { content } from '../src/post/semantic/policy.js';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const suite =
  process.env.RUN_EMBEDDING_MODEL === '1' ? describe : describe.skip;
suite('pinned local E5 model, CPU FP32 without network', () => {
  const embedding = new E5EmbeddingProvider();
  const signal = () => AbortSignal.timeout(10000);
  beforeAll(async () => {
    await embedding.initialize();
  }, 60000);
  afterAll(async () => {
    await embedding.close();
  });

  it('matches the reference short-text pipeline and produces repeatable normalized vectors', async () => {
    const text = content({
      title: '강남역 교통사고',
      content: '강남역 앞 도로에서 교통사고가 발생했습니다.',
    }).text;
    const first = await embedding.embed(text, signal());
    const second = await embedding.embed(text, signal());
    expect(first).toEqual(second);
    expect(first.version).toBe(E5_VERSION);
    expect(first.vector).toHaveLength(384);
    expect(Math.hypot(...first.vector)).toBeCloseTo(1, 6);

    const { pipeline } = await import('@huggingface/transformers');
    const reference = await pipeline('feature-extraction', modelPath(), {
      local_files_only: true,
      device: 'cpu',
      dtype: 'fp32',
      session_options: { intraOpNumThreads: 1, interOpNumThreads: 1 },
    });
    try {
      const output = await reference(`query: ${text}`, {
        pooling: 'mean',
        normalize: true,
      });
      const expected = Array.from(output.data, Number);
      expect(
        Math.max(
          ...first.vector.map((value, i) => Math.abs(value - expected[i]!)),
        ),
      ).toBeLessThan(0.00001);
    } finally {
      await reference.dispose();
    }
  });

  it('processes a 5000-character body including its last tokens', async () => {
    const common = '현장 상황을 확인하는 중입니다. '.repeat(280);
    const text = common.slice(0, 4960);
    const a = await embedding.embed(
      content({
        title: '상황 안내',
        content: `${text}현재 화재가 발생했습니다.`,
      }).text,
      signal(),
    );
    const b = await embedding.embed(
      content({
        title: '상황 안내',
        content: `${text}화재가 아니라 소방 훈련입니다.`,
      }).text,
      signal(),
    );
    expect(a.vector.every(Number.isFinite)).toBe(true);
    expect(Math.hypot(...a.vector)).toBeCloseTo(1, 6);
    expect(a.vector).not.toEqual(b.vector);
    // 끝부분 반영 여부만 검증한다. 중복 판정 품질이나 운영 임계값을 보증하지 않는다.
  }, 30000);

  it('rejects incomplete artifacts before creating an ONNX session', async () => {
    const path = await mkdtemp(join(tmpdir(), 'wgo-e5-invalid-'));
    try {
      await writeFile(join(path, 'config.json'), '{}');
      await expect(loadE5Runtime(path)).rejects.toThrow('checksum mismatch');
      await writeFile(join(path, 'config.json'), '{  "a": 1 }');
      const hash = await artifactHash(join(path, 'config.json'), true);
      await writeFile(join(path, 'config.json'), '{"a":1}');
      expect(await artifactHash(join(path, 'config.json'), true)).toBe(hash);
    } finally {
      await rm(path, { recursive: true, force: true });
    }
  });
});
