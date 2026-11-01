import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';
export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WGO Moderation Service HTTP API')
    .setVersion('1.0.0')
    .setDescription(
      'Internal Moderation REST contract. Report operations require a Gateway service JWT and Gateway-generated user context. Public clients authenticate to the Gateway using their user Access JWT. Lifecycle/AI events are separate contracts.',
    )
    .addBearerAuth(
      { type: 'http', scheme: 'bearer', bearerFormat: 'Service JWT (ES256)' },
      'service-jwt',
    )
    .build();
  SwaggerModule.setup(
    'docs',
    app,
    () => {
      const document = SwaggerModule.createDocument(app, config);
      const request = document.components?.schemas?.CreateReportRequest;
      if (request && 'properties' in request) {
        request.additionalProperties = false;
        // OpenAPI 3.0 cannot express JSON Schema if/then. These alternatives
        // mirror the runtime rule that only comment targets carry commentId.
        request.oneOf = [
          {
            properties: { targetType: { type: 'string', enum: ['POST'] } },
            not: { required: ['commentId'] },
          },
          {
            properties: { targetType: { type: 'string', enum: ['COMMENT'] } },
            required: ['commentId'],
          },
        ];
      }
      return document;
    },
    { jsonDocumentUrl: 'docs/openapi.json' },
  );
}
