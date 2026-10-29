import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WGO User Service HTTP API')
    .setDescription(
      'Internal User REST contract. All /api/v1 operations require the HTTP Gateway service JWT. Identity headers are Gateway-generated context, not public credentials. Public clients use the Gateway with a user Access JWT; login/refresh, nickname availability and terms do not require a user token. Internal gRPC is outside this contract.',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Service JWT (ES256)' },
      'service-jwt',
    )
    .setVersion('1.0.0')
    .build();
  // Build lazily to keep documentation work off the ordinary startup path.
  SwaggerModule.setup(
    'docs',
    app,
    () => {
      const document = SwaggerModule.createDocument(app, config);
      for (const [path, item] of Object.entries(document.paths)) {
        if (!path.startsWith('/api/v1/')) continue;
        for (const method of [
          'get',
          'post',
          'patch',
          'put',
          'delete',
        ] as const) {
          const operation = item[method];
          if (operation) {
            operation.security = [{ 'service-jwt': [] }];
            operation.responses['401'] ??= {
              description:
                'Invalid Gateway service authentication or user context.',
            };
            operation.responses['403'] ??= {
              description: 'Gateway operation not permitted.',
            };
          }
        }
      }
      return document;
    },
    { jsonDocumentUrl: 'docs/openapi.json' },
  );
}
