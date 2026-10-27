import 'reflect-metadata';
import { createConnection } from 'mongoose';
import { createEmbeddingProvider } from './embedding-provider.js';
import { ElasticsearchIndex } from './elasticsearch.js';
import { PostSchema } from '../infrastructure/post.schemas.js';
import { MongooseSemanticSource } from './mongoose-source.js';
import { rebuildSemanticIndex } from './rebuild.js';
import { group, semanticRedis } from './worker.js';

async function main() {
  const command = process.argv[2];
  if (!['init', 'backfill', 'rebuild'].includes(command ?? ''))
    throw new Error('Usage: semantic:command init|backfill|rebuild');
  const embedding = createEmbeddingProvider();
  try {
    await run(command!, embedding);
  } finally {
    await embedding.close();
  }
}

async function run(
  command: string,
  embedding: ReturnType<typeof createEmbeddingProvider>,
) {
  const index = new ElasticsearchIndex();
  if (command === 'init') {
    const existing = await index.request(
      'GET',
      `_alias/${index.target}`,
      undefined,
      undefined,
      true,
    );
    if (existing) throw new Error('Alias already exists; use rebuild');
    const staging = index.at(`${group(embedding.version)}-${Date.now()}`);
    await staging.create();
    await staging.switchAlias(index.target);
    console.info({ index: staging.target, alias: index.target });
    return;
  }
  await embedding.initialize();
  if (!embedding.ready)
    throw new Error('Embedding model is not connected; no data was changed');
  const db = createConnection(
    process.env.MONGODB_URI ??
      'mongodb://localhost:27017/wgo_post?replicaSet=rs0',
  );
  const redis = semanticRedis();
  redis.on('error', (error) => console.error(String(error)));
  try {
    await db.asPromise();
    await redis.connect();
    const source = new MongooseSemanticSource(
      db.model('Post', PostSchema, 'posts'),
    );
    console.info(await rebuildSemanticIndex(source, embedding, index, redis));
  } finally {
    await db.close();
    if (redis.isOpen) await redis.quit();
  }
}
void main().catch((error) => {
  console.error(String(error));
  process.exitCode = 1;
});
