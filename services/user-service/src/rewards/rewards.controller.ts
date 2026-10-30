import {
  ApiHeader,
  ApiOperation,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import {
  GrowthResult,
  CreditHistoryResult,
  BadgeHistoryResult,
} from './rewards.openapi.js';
import {
  BadRequestException,
  Controller,
  Get,
  Headers,
  Query,
  UnauthorizedException,
} from '@nestjs/common';
import { ActivityService } from './activity.service.js';
import { parseUserId } from '../user-id.js';
import type {
  GrowthResponse,
  CreditHistoryResponse,
} from './reward-response.dto.js';
function user(value: unknown): string {
  const id = parseUserId(value);
  if (!id)
    throw new UnauthorizedException('Invalid authentication credentials');
  return id;
}
@ApiTags('Rewards')
@ApiHeader({
  name: 'X-User-Id',
  required: true,
  description: 'Verified Gateway user context',
  schema: { type: 'string' },
})
@ApiResponse({ status: 400, description: 'Invalid pagination input' })
@ApiResponse({ status: 404, description: 'User not found' })
@Controller('api/v1/users/me')
export class RewardsController {
  constructor(private readonly activities: ActivityService) {}
  @Get('credits')
  @ApiOperation({ summary: 'Get own credits and growth' })
  @ApiResponse({ status: 200, type: GrowthResult })
  credits(@Headers('x-user-id') id: unknown): Promise<GrowthResponse> {
    return this.activities.summary(user(id));
  }
  @Get('growth')
  @ApiOperation({ summary: 'Get own persistent growth progress' })
  @ApiResponse({ status: 200, type: GrowthResult })
  growth(@Headers('x-user-id') id: unknown): Promise<GrowthResponse> {
    return this.activities.summary(user(id));
  }
  @Get('credits/history')
  @ApiResponse({ status: 200, type: CreditHistoryResult })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiQuery({ name: 'before', required: false, type: String })
  history(
    @Headers('x-user-id') value: unknown,
    @Query('limit') limit: unknown,
    @Query('before') before: unknown,
  ): Promise<CreditHistoryResponse> {
    const id = user(value);
    this.page(limit, before);
    return this.activities.history(
      id,
      limit === undefined ? 20 : Number(limit),
      before === undefined ? null : (before as string),
    );
  }
  @Get('badges/history')
  @ApiResponse({ status: 200, type: BadgeHistoryResult })
  @ApiQuery({
    name: 'limit',
    required: false,
    type: Number,
    minimum: 1,
    maximum: 100,
  })
  @ApiQuery({ name: 'before', required: false, type: String })
  badgeHistory(
    @Headers('x-user-id') value: unknown,
    @Query('limit') limit: unknown,
    @Query('before') before: unknown,
  ) {
    const id = user(value);
    this.page(limit, before);
    return this.activities.badgeHistory(
      id,
      limit === undefined ? 20 : Number(limit),
      before === undefined ? null : (before as string),
    );
  }
  private page(limit: unknown, before: unknown): void {
    if (
      limit !== undefined &&
      (typeof limit !== 'string' || !/^[1-9]\d?$|^100$/.test(limit))
    )
      throw new BadRequestException('limit must be 1..100');
    if (
      before !== undefined &&
      (typeof before !== 'string' ||
        !/^[1-9]\d{0,18}$/.test(before) ||
        BigInt(before) > 9223372036854775807n)
    )
      throw new BadRequestException('Invalid before cursor');
  }
}
