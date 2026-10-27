import { randomUUID } from 'node:crypto';
import { ElasticsearchIndex } from './elasticsearch.js';
import { IndexSemanticPost, semanticEvent } from './index-post.js';
import type { EmbeddingProvider, SemanticSource } from './ports.js';
import { active, content, validateEmbedding } from './policy.js';
import {
  group,
  SEMANTIC_STREAM,
  type SemanticRedis,
  withSemanticLease,
} from './worker.js';

const greater = (a: string, b: string) => {
  const [am, as] = a.split('-').map(BigInt) as [bigint, bigint];
  const [bm, bs] = b.split('-').map(BigInt) as [bigint, bigint];
  return am > bm || (am === bm && as > bs);
};
async function streamInfo(redis: SemanticRedis) {
  const info = (await redis.sendCommand([
    'XINFO',
    'STREAM',
    SEMANTIC_STREAM,
  ])) as unknown as (string | unknown)[];
  return Object.fromEntries(
    Array.from({ length: info.length / 2 }, (_, i) => [
      String(info[i * 2]),
      info[i * 2 + 1],
    ]),
  );
}

export async function rebuildSemanticIndex(
  source: SemanticSource,
  embedding: EmbeddingProvider,
  index: ElasticsearchIndex,
  redis: SemanticRedis,
) {
  // 준비 검사는 lease·인덱스 생성보다 먼저 수행한다. 테스트만 fixture 포트를 주입한다.
  if (!embedding.ready)
    throw new Error('Embedding model is not connected; rebuild did not start');
  const result = await withSemanticLease(
    redis,
    embedding.version,
    async (signal) => {
      try {
        await redis.xGroupCreate(
          SEMANTIC_STREAM,
          group(embedding.version),
          '0',
          { MKSTREAM: true },
        );
      } catch (error) {
        if (!String(error).includes('BUSYGROUP')) throw error;
      }
      const startInfo = await streamInfo(redis);
      const watermark = String(startInfo['last-generated-id']);
      const staging = index.at(
        `${group(embedding.version)}-${Date.now()}-${randomUUID().slice(0, 8)}`,
      );
      const stateKey = `${group(embedding.version)}:rebuild`;
      await redis.hSet(stateKey, {
        index: staging.target,
        watermark,
        phase: 'scanning',
      });
      try {
        await staging.create();
        const indexing = new IndexSemanticPost(source, embedding, staging);
        const run = (id: string) =>
          indexing.execute(
            id,
            AbortSignal.any([signal, AbortSignal.timeout(10000)]),
          );
        let scanned = 0;
        // Stream 보존 기간 이전의 원본도 복구한다. 상태나 생성 시각으로 스캔을 제한하지 않는다.
        for await (const post of source.scan()) {
          signal.throwIfAborted();
          await run(post.postId);
          scanned++;
        }
        const endInfo = await streamInfo(redis);
        const end = String(endInfo['last-generated-id']);
        await redis.hSet(stateKey, { end, phase: 'catching-up' });
        let cursor = watermark;
        let replayed = 0n;
        while (greater(end, cursor)) {
          const entries = await redis.xRange(
            SEMANTIC_STREAM,
            `(${cursor}`,
            end,
            { COUNT: 100 },
          );
          if (!entries.length) break;
          for (const entry of entries) {
            const id = semanticEvent(entry.message);
            if (id) await run(id);
            cursor = entry.id;
            replayed++;
          }
        }
        // XTRIM은 max-deleted-entry-id를 갱신하지 않는다. 누적 발행 수와 실제
        // 재생 수를 비교해야 스캔 중 trim으로 사라진 이벤트도 감지할 수 있다.
        const expected =
          BigInt(String(endInfo['entries-added'])) -
          BigInt(String(startInfo['entries-added']));
        if (replayed !== expected)
          throw new Error(
            'Stream retention crossed rebuild watermark; retry from source',
          );
        // XDEL로 삭제한 구간도 전환 전에 확인한다.
        const deleted = String(
          (await streamInfo(redis))['max-deleted-entry-id'] ?? '0-0',
        );
        if (greater(deleted, watermark))
          throw new Error(
            'Stream retention crossed rebuild watermark; retry from source',
          );
        await staging.refresh();
        await redis.hSet(stateKey, { phase: 'validating' });
        let verified = 0;
        for await (const doc of staging.documents()) {
          signal.throwIfAborted();
          const post = (await source.batch([doc.postId]))[0];
          if (!post || !active(post, new Date())) {
            await staging.remove(doc.postId, signal);
            continue;
          }
          if (
            doc.contentHash !== content(post).hash ||
            doc.sourceUpdatedAt !== post.updatedAt.toISOString() ||
            doc.status !== post.status ||
            doc.category !== post.category ||
            doc.expiresAt !== (post.expiresAt?.toISOString() ?? null)
          )
            throw new Error('Source changed during validation; retry rebuild');
          validateEmbedding(
            { vector: doc.embedding, version: doc.embeddingVersion },
            embedding.version,
          );
          verified++;
        }
        // 원본→인덱스 대조도 수행하여 스캔 중 추가된 원본의 누락을 발견한다.
        for await (const post of source.scan()) {
          if (!active(post, new Date())) continue;
          const doc = await staging.get(post.postId, signal);
          if (
            !doc ||
            doc.contentHash !== content(post).hash ||
            doc.embeddingVersion !== embedding.version
          )
            throw new Error('Source missing from rebuilt index; retry rebuild');
        }
        await staging.refresh();
        signal.throwIfAborted();
        await staging.switchAlias(index.target);
        await redis.hSet(stateKey, {
          phase: 'complete',
          scanned: String(scanned),
          verified: String(verified),
        });
        // 기존 그룹의 Pending은 그대로 남겨 새 별칭에 멱등 재처리한다.
        return { index: staging.target, watermark, end, scanned, verified };
      } catch (error) {
        await redis.hSet(stateKey, { phase: 'failed', error: String(error) });
        throw error;
      }
    },
  );
  if (!result)
    throw new Error('Semantic worker/rebuild is busy; retry after current job');
  return result.value;
}
