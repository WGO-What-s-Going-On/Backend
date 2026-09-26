import type { INestApplication } from '@nestjs/common';
import { DocumentBuilder, SwaggerModule } from '@nestjs/swagger';

export function configureSwagger(app: INestApplication): void {
  const config = new DocumentBuilder()
    .setTitle('WGO Post Service API')
    .setDescription('게시물·댓글·반응·참여 API와 서비스 간 내부 조회/작성 계약. 공개 생성 API의 X-User-Id는 로컬·테스트 전용입니다.')
    .setVersion('1.0')
    .addBearerAuth({ type: 'http', scheme: 'bearer', bearerFormat: 'JWT', description: 'WS Gateway가 발급한 단기 서비스 JWT' }, 'service-jwt')
    .build();

  SwaggerModule.setup('docs', app, () => SwaggerModule.createDocument(app, config), {
    jsonDocumentUrl: 'docs/openapi.json',
  });
}
