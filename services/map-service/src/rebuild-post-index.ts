import { PostIndex } from './post-index.js';

const index = new PostIndex();
try {
  await index.connect();
  console.info(`Rebuilt ${await index.rebuild()} post index rows`);
} finally {
  await index.close();
}
