import { BadRequestException } from '@nestjs/common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';

export enum ReportReason {
  SPAM = 'SPAM',
  HARASSMENT = 'HARASSMENT',
  INAPPROPRIATE_CONTENT = 'INAPPROPRIATE_CONTENT',
  FALSE_INFORMATION = 'FALSE_INFORMATION',
  OTHER = 'OTHER',
}
export enum ReportStatus {
  PENDING = 'PENDING',
  WITHDRAWN = 'WITHDRAWN',
  REVIEWED = 'REVIEWED',
}
export class CreateReportRequest {
  @ApiProperty({ enum: ['POST', 'COMMENT'] }) targetType!: 'POST' | 'COMMENT';
  @ApiProperty({
    example: 'post_123e4567-e89b-42d3-a456-426614174000',
    pattern: `^post_${uuid}$`,
  })
  postId!: string;
  @ApiPropertyOptional({
    description: 'Required only for COMMENT.',
    pattern: `^comment_${uuid}$`,
    example: 'comment_123e4567-e89b-42d3-a456-426614174000',
  })
  commentId?: string;
  @ApiProperty({ enum: ReportReason }) reason!: ReportReason;
  @ApiPropertyOptional({ maxLength: 2000 }) description?: string;
}
export class ReportResponse {
  @ApiProperty({
    example: 'report_123e4567-e89b-42d3-a456-426614174000',
    pattern: `^report_${uuid}$`,
  })
  reportId!: string;
  @ApiProperty({ enum: ReportStatus }) status!: ReportStatus;
  @ApiProperty({ format: 'date-time' }) createdAt!: string;
  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  withdrawnAt!: string | null;
}
export type StoredReport = ReportResponse &
  CreateReportRequest & { reporterUserId: string };
export const reportIdPattern = new RegExp(`^report_${uuid}$`);
export function parseReport(raw: unknown): CreateReportRequest {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Report object required');
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (key) =>
        ![
          'targetType',
          'postId',
          'commentId',
          'reason',
          'description',
        ].includes(key),
    ) ||
    !['POST', 'COMMENT'].includes(String(input.targetType)) ||
    typeof input.postId !== 'string' ||
    !new RegExp(`^post_${uuid}$`).test(input.postId) ||
    !Object.values(ReportReason).includes(input.reason as ReportReason) ||
    (input.targetType === 'COMMENT'
      ? typeof input.commentId !== 'string' ||
        !new RegExp(`^comment_${uuid}$`).test(input.commentId)
      : input.commentId !== undefined) ||
    (input.description !== undefined &&
      (typeof input.description !== 'string' ||
        [...input.description].length > 2000))
  )
    throw new BadRequestException('Invalid report fields');
  return input as unknown as CreateReportRequest;
}
export function response(report: StoredReport): ReportResponse {
  return {
    reportId: report.reportId,
    status: report.status,
    createdAt: report.createdAt,
    withdrawnAt: report.withdrawnAt,
  };
}

export class ReportHttpError {
  @ApiProperty({ type: 'integer' }) statusCode!: number;
  @ApiProperty() message!: string;
  @ApiProperty() error!: string;
}
