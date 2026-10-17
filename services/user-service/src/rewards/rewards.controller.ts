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
@Controller('api/v1/users/me')
export class RewardsController {
  constructor(private readonly activities: ActivityService) {}
  @Get('credits')
  credits(@Headers('x-user-id') id: unknown): Promise<GrowthResponse> {
    return this.activities.summary(user(id));
  }
  @Get('growth')
  growth(@Headers('x-user-id') id: unknown): Promise<GrowthResponse> {
    return this.activities.summary(user(id));
  }
  @Get('credits/history')
  history(
    @Headers('x-user-id') value: unknown,
    @Query('limit') limit: unknown,
    @Query('before') before: unknown,
  ): Promise<CreditHistoryResponse> {
    const id = user(value);
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
    return this.activities.history(
      id,
      limit === undefined ? 20 : Number(limit),
      before === undefined ? null : (before as string),
    );
  }
}
