import dataSource from '../data-source.js';
import { seedBadgeCatalog } from '../../rewards/badge-catalog.js';
async function main() {
  await dataSource.initialize();
  try {
    await dataSource.transaction(seedBadgeCatalog);
  } finally {
    await dataSource.destroy();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
