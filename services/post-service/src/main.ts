import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { StructuredLogger, installHttpLogging } from './observability/nest.js';
import { createLogger } from './observability/logging.js';

import { AppModule } from './app.module.js';
import { configureSwagger } from './swagger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger('post-service'),
  });
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');

  installHttpLogging(app, 'post-service');
  app.enableShutdownHooks();
  configureSwagger(app);

  await app.listen(port);
}

void bootstrap().catch((error: unknown) => {
  createLogger('post-service', 'lifecycle').failure(
    'service.start.failed',
    error,
    'SERVICE_START_FAILED',
    'Service failed to start',
  );
  process.exitCode = 1;
});
