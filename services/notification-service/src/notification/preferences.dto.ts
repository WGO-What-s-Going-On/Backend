import { ApiPropertyOptional } from '@nestjs/swagger';
export class NotificationPreferencesPatch {
  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Allow nearby notifications. Separate nearby subscription and location consent are still required.',
  })
  nearby?: boolean;
  @ApiPropertyOptional({ type: Boolean }) replies?: boolean;
  @ApiPropertyOptional({ type: Boolean }) reactions?: boolean;
  @ApiPropertyOptional({ type: Boolean }) lifecycle?: boolean;
  @ApiPropertyOptional({ type: Boolean }) rewards?: boolean;
  @ApiPropertyOptional({ type: Boolean }) votes?: boolean;
  @ApiPropertyOptional({ type: Boolean }) moderation?: boolean;
}
