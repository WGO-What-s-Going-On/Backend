import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { configureSwagger } from './swagger.js';
import { StructuredLogger, installHttpLogging } from './observability/nest.js';
import { createLogger } from './observability/logging.js';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger('moderation-service'),
  });
  installHttpLogging(app, 'moderation-service');
  app.enableShutdownHooks();
  configureSwagger(app);
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');

  await app.listen(port);
}

void bootstrap().catch((error: unknown) => {
  createLogger('moderation-service', 'lifecycle').failure(
    'service.start.failed',
    error,
    'SERVICE_START_FAILED',
    'Service failed to start',
  );
  process.exitCode = 1;
});
