import { PostIndex } from './post-index.js';
import { GEO_STATE, GEO_DIRTY } from './geo-index-state.js';

const index = new PostIndex();
try {
  await index.connect();
  console.info(`Rebuilt ${await index.rebuild()} post index rows`);
  console.info('GEO index certification', {
    ready: (await index.redis.hGet(GEO_STATE, 'ready')) === '1',
    unfinishedWrites: await index.redis.sCard(GEO_DIRTY),
  });
} finally {
  await index.close();
}
