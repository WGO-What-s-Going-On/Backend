import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
import 'reflect-metadata';

import { ConfigService } from '@nestjs/config';
import { NestFactory } from '@nestjs/core';

import { AppModule } from './app.module.js';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  app.enableShutdownHooks();
  SwaggerModule.setup(
    'docs',
    app,
    () =>
      SwaggerModule.createDocument(
        app,
        new DocumentBuilder()
          .setTitle('WGO Moderation API')
          .setVersion('1.0')
          .build(),
      ),
    { jsonDocumentUrl: 'docs/openapi.json' },
  );
  const config = app.get(ConfigService);
  const port = config.getOrThrow<number>('app.port');

  await app.listen(port);
}

void bootstrap();
