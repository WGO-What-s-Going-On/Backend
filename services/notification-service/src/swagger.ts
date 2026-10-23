import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WGO Notification Service HTTP API')
    .setDescription(
      'Current implementation provides only GET /health/live. Notification APIs, subscriptions and delivery are not implemented. The Gateway excludes this health endpoint and reports no public operations for this service.',
    )
    .setVersion('1.0.0')
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    () => SwaggerModule.createDocument(app, config),
    { jsonDocumentUrl: 'docs/openapi.json' },
  );
}
