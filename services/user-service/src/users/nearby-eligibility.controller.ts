import {
  Body,
  Controller,
  Post,
  HttpCode,
  BadRequestException,
} from '@nestjs/common';
import { ApiExcludeController } from '@nestjs/swagger';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { parseUserId } from '../user-id.js';

@ApiExcludeController()
@Controller('internal/notifications/nearby')
export class NearbyEligibilityController {
  constructor(@InjectDataSource() private readonly db: DataSource) {}
  @Post('eligibility')
  @HttpCode(200)
  async check(@Body() body: unknown) {
    const value = body as { userIds?: unknown };
    if (
      !value ||
      typeof value !== 'object' ||
      Array.isArray(value) ||
      Object.keys(value).some((k) => k !== 'userIds') ||
      !Array.isArray(value.userIds) ||
      value.userIds.length < 1 ||
      value.userIds.length > 50 ||
      value.userIds.some((id) => !parseUserId(id)) ||
      new Set(value.userIds).size !== value.userIds.length
    )
      throw new BadRequestException('Invalid nearby eligibility request');
    // Read the owning service's current consent, including revocation; no inferred consent.
    const users = await this.db.query(
      `WITH current_terms AS (
      SELECT DISTINCT ON (code) id,code FROM terms
      WHERE code IN ('LOCATION','PRIVACY_COLLECTION_USE') AND effective_at<=now()
      ORDER BY code,effective_at DESC,id DESC
    ) SELECT requested.user_id::text AS "userId", (u.status='ACTIVE' AND
      (SELECT count(*) FROM current_terms)=2 AND NOT EXISTS (
        SELECT 1 FROM current_terms t WHERE NOT EXISTS (
          SELECT 1 FROM user_term_consents c WHERE c.user_id=u.id AND c.term_id=t.id
          AND c.revoked_at IS NULL AND c.agreed_at<=now()
        )
      )) IS TRUE AS eligible
    FROM unnest($1::bigint[]) AS requested(user_id) LEFT JOIN users u ON u.id=requested.user_id`,
      [value.userIds],
    );
    return { users };
  }
}
