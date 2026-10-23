import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WGO User Service HTTP API')
    .setDescription(
      'Current REST implementation. Auth endpoints issue user tokens, but the HTTP Gateway and User REST endpoints do not validate user Bearer JWTs yet. X-User-Id and logout X-Session-Id are read directly; use only trusted local test context. /api/v1/terms is not routed by the current Gateway. Internal gRPC is outside this HTTP contract.',
    )
    .setVersion('1.0.0')
    .build();
  // Build lazily to keep documentation work off the ordinary startup path.
  SwaggerModule.setup(
    'docs',
    app,
    () => SwaggerModule.createDocument(app, config),
    { jsonDocumentUrl: 'docs/openapi.json' },
  );
}
