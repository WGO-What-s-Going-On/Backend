import 'reflect-metadata';

import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';

import { StructuredLogger, installHttpLogging } from './observability/nest.js';
import { createLogger } from './observability/logging.js';

import { AppModule } from './app.module.js';
import { configureSwagger } from './swagger.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule, {
    logger: new StructuredLogger('user-service'),
  });
  installHttpLogging(app, 'user-service');
  app.enableShutdownHooks();
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');

  configureSwagger(app);
  await app.listen(port);
}

void bootstrap().catch((error: unknown) => {
  createLogger('user-service', 'lifecycle').failure(
    'service.start.failed',
    error,
    'SERVICE_START_FAILED',
    'Service failed to start',
  );
  process.exitCode = 1;
});
