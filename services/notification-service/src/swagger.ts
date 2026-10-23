import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WGO Notification Service HTTP API')
    .setDescription(
      'Provides health, notification listing, unread count, mark-read and push subscription APIs. Local/test requests use X-User-Id directly; production notification requests are blocked until authentication is integrated. The Gateway excludes health and includes routed notification operations.',
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
