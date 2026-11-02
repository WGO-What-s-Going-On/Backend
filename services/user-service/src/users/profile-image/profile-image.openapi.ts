import { ApiProperty } from '@nestjs/swagger';
import { IMAGE_MAX_BYTES, IMAGE_TYPES } from './profile-image.config.js';

export class ProfileImageUploadBody {
  @ApiProperty({ enum: IMAGE_TYPES }) contentType!: string;
  @ApiProperty({ type: 'integer', minimum: 1, maximum: IMAGE_MAX_BYTES })
  sizeBytes!: number;
  @ApiProperty({
    pattern: '^[A-Za-z0-9+/]{43}=$',
    description: 'Canonical SHA-256 Base64 digest of the file bytes.',
  })
  checksum!: string;
}
export class ProfileImageUploadResult {
  @ApiProperty({ format: 'uuid' }) uploadId!: string;
  @ApiProperty() uploadUrl!: string;
  @ApiProperty({ enum: ['PUT'] }) method!: string;
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'string' },
    description:
      'Send Content-Type and x-goog-if-generation-match exactly. Browser sets signed Content-Length from the Blob. Never send WGO JWT to GCS.',
  })
  headers!: Record<string, string>;
  @ApiProperty({ format: 'date-time' }) expiresAt!: string;
}
export class ProfileImageCompleteResult {
  @ApiProperty({ format: 'uuid' }) uploadId!: string;
  @ApiProperty({ enum: ['APPLIED'] }) status!: string;
  @ApiProperty() profileImageKey!: string;
  @ApiProperty({
    description:
      'False if this historical upload has since been replaced or removed. Replays never restore an old image.',
  })
  isCurrent!: boolean;
}
export class ProfileImageUrlResult {
  @ApiProperty({ type: String, nullable: true }) profileImageKey!:
    | string
    | null;
  @ApiProperty({ type: String, nullable: true }) url!: string | null;
  @ApiProperty({ type: String, nullable: true, format: 'date-time' })
  expiresAt!: string | null;
}
