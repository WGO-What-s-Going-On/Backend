import { ApiPropertyOptional } from '@nestjs/swagger';
export class NotificationPreferencesPatch {
  @ApiPropertyOptional() nearby?: boolean;
  @ApiPropertyOptional() replies?: boolean;
  @ApiPropertyOptional() reactions?: boolean;
  @ApiPropertyOptional() lifecycle?: boolean;
  @ApiPropertyOptional() rewards?: boolean;
  @ApiPropertyOptional() votes?: boolean;
  @ApiPropertyOptional() moderation?: boolean;
}
