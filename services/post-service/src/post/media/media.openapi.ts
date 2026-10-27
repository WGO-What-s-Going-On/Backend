import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { MEDIA_TYPES } from './media.policy.js';
export class MediaUploadBody {
  @ApiProperty({ enum: MEDIA_TYPES }) contentType!: string;
  @ApiProperty({
    minimum: 1,
    maximum: 104857600,
    description: '기본 이미지 10MiB, 동영상 100MiB. 서버 설정 상한 적용.',
  })
  sizeBytes!: number;
  @ApiProperty({
    description: '파일 바이트의 SHA-256 base64 digest (hex 아님)',
  })
  checksum!: string;
}
export class MediaStatusResponse {
  @ApiProperty() mediaId!: string;
  @ApiProperty({ enum: ['PENDING', 'READY', 'ATTACHED', 'DELETING'] })
  status!: string;
  @ApiPropertyOptional({ enum: ['IMAGE', 'VIDEO'] }) type?: string;
  @ApiPropertyOptional({ format: 'date-time' }) attachmentExpiresAt?: string;
}
export class UploadTarget {
  @ApiProperty({ enum: ['PUT'] }) method!: string;
  @ApiProperty() url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      '반환한 헤더 그대로 전송. 브라우저는 Blob 길이로 Content-Length를 자동 설정.',
  })
  headers!: Record<string, string>;
}
export class MediaUploadResponse extends MediaStatusResponse {
  @ApiProperty({ type: UploadTarget }) upload!: UploadTarget;
}
export class MediaResponse {
  @ApiProperty() mediaId!: string;
  @ApiProperty({ enum: ['IMAGE', 'VIDEO'] }) type!: string;
  @ApiProperty() contentType!: string;
  @ApiProperty() sizeBytes!: number;
  @ApiProperty() url!: string;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
