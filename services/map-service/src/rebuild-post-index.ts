import { createLogger } from './observability/logging.js';
const log = createLogger('map-service', 'map');
import { PostIndex } from './post-index.js';
import { GEO_STATE, GEO_DIRTY } from './geo-index-state.js';

const index = new PostIndex();
try {
  await index.connect();
  log.success('map.index.rebuilt', 'Map index rebuilt.', {
    count: await index.rebuild(),
  });
  log.success('map.index.certification', 'Map index certification checked.', {
    status:
      (await index.redis.hGet(GEO_STATE, 'ready')) === '1'
        ? 'ready'
        : 'not-ready',
    pending: await index.redis.sCard(GEO_DIRTY),
  });
} catch (error) {
  log.failure(
    'map.index.rebuild.failed',
    error,
    'INDEX_REBUILD_FAILED',
    'Map index rebuild failed.',
  );
  throw error;
} finally {
  await index.close();
}
