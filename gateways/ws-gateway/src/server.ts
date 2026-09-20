import { loadEnvFile } from 'node:process';

import { buildApp } from './app.js';
import { loadConfig } from './config.js';

try {
  loadEnvFile();
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
}

const config = loadConfig();
const app = await buildApp({ config });

const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  app.log.info({ signal }, 'shutting down realtime gateway');
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  const address = await app.listen({ host: config.host, port: config.port });
  app.log.info({ address }, 'realtime gateway started');
} catch (error) {
  app.log.fatal(error, 'failed to start realtime gateway');
  await app.close();
  process.exit(1);
}
