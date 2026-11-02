import dataSource from '../data-source.js';
import { provisionTerms, readTermsSeed } from './terms-seed.js';

async function seedTerms(): Promise<void> {
  // Reject missing documents before opening a database connection.
  readTermsSeed(process.env);
  await dataSource.initialize();

  try {
    await provisionTerms(dataSource, process.env);
  } finally {
    await dataSource.destroy();
  }
}

seedTerms().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
