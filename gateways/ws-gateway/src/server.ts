import { safeError } from './observability/logging.js';
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

const shutdown = async (_signal: NodeJS.Signals): Promise<void> => {
  app.log.info(
    { event: 'service.stopping', domain: 'lifecycle', outcome: 'success' },
    'shutting down realtime gateway',
  );
  await app.close();
  process.exit(0);
};

process.once('SIGINT', () => void shutdown('SIGINT'));
process.once('SIGTERM', () => void shutdown('SIGTERM'));

try {
  await app.listen({ host: config.host, port: config.port });
  app.log.info(
    { event: 'service.started', domain: 'lifecycle', outcome: 'success' },
    'realtime gateway started',
  );
} catch (error) {
  app.log.fatal(
    {
      event: 'service.start.failed',
      domain: 'lifecycle',
      outcome: 'failure',
      error: safeError(
        error,
        'SERVICE_START_FAILED',
        'Gateway startup failed.',
      ),
    },
    'failed to start realtime gateway',
  );
  await app.close();
  process.exit(1);
}
