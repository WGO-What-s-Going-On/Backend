import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';
import { validateRuntimeFiles } from './runtime-files.js';
import { ElasticsearchIndex, mapping } from './post/semantic/elasticsearch.js';

await validateRuntimeFiles();
const suffix = randomUUID().replaceAll('-', '');
const collectionName = `gcp_smoke_${suffix}`;
const indexName = `gcp-smoke-${suffix}`;
const db = await mongoose
  .createConnection(
    process.env.MONGODB_URI ??
      'mongodb://localhost:27017/wgo_post?replicaSet=rs0',
    { serverSelectionTimeoutMS: 10000 },
  )
  .asPromise();
const search = new ElasticsearchIndex(indexName, undefined, undefined, false);
let indexCreated = false;
try {
  const collection = await db.createCollection<{ state: string }>(
    collectionName,
  );
  const session = await db.startSession();
  try {
    await session.withTransaction(async () => {
      await collection.insertOne({ state: 'committed' }, { session });
    });
    assert.equal(await collection.countDocuments(), 1);
    await assert.rejects(
      session.withTransaction(async () => {
        await collection.insertOne({ state: 'rolled-back' }, { session });
        throw new Error('intentional transaction rollback');
      }),
      /intentional transaction rollback/,
    );
    assert.equal(await collection.countDocuments(), 1);
  } finally {
    await session.endSession();
  }
  await search.request('PUT', indexName, {
    mappings: mapping,
    settings: { number_of_shards: 1, number_of_replicas: 0 },
  });
  indexCreated = true;
  const embedding = Array.from({ length: 384 }, (_, i) => (i === 0 ? 1 : 0));
  await search.request('PUT', `${indexName}/_doc/smoke?refresh=true`, {
    postId: 'smoke',
    embedding,
  });
  const result = await search.request<{ hits: { hits: unknown[] } }>(
    'POST',
    `${indexName}/_search`,
    {
      query: {
        script_score: {
          query: { match_all: {} },
          script: {
            source: "cosineSimilarity(params.vector, 'embedding') + 1.0",
            params: { vector: embedding },
          },
        },
      },
    },
  );
  assert.equal(result.hits.hits.length, 1);
  process.stdout.write(
    'MongoDB transaction commit/rollback and Elasticsearch vector query passed\n',
  );
} finally {
  try {
    if (indexCreated) await search.request('DELETE', indexName);
  } finally {
    try {
      await db.dropCollection(collectionName);
    } finally {
      await db.close();
    }
  }
}
