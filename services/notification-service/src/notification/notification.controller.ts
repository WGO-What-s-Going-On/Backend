import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  Headers,
  NotFoundException,
  Param,
  Patch,
  Put,
  Query,
  Body,
  ServiceUnavailableException,
} from '@nestjs/common';

import { NotificationService } from './notification.service.js';
import { PushSubscriptionService } from '../push-subscription/push-subscription.service.js';
import type { PushPlatform } from '../push-subscription/push-subscription.js';

@Controller('api/v1/notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly subscriptions: PushSubscriptionService,
  ) {}

  @Get()
  list(
    @Headers('x-user-id') header: unknown,
    @Query('limit') limit?: string,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.list(
      requireUserId(header),
      limit === undefined ? 20 : Number(limit),
      cursor,
    );
  }

  @Get('unread-count')
  async unread(@Headers('x-user-id') header: unknown) {
    return { count: await this.notifications.unread(requireUserId(header)) };
  }

  @Patch(':notificationId/read')
  async markRead(
    @Headers('x-user-id') header: unknown,
    @Param('notificationId') notificationId: string,
  ) {
    const result = await this.notifications.markRead(
      requireUserId(header),
      notificationId,
    );
    if (!result) throw new NotFoundException('notification not found');
    return result;
  }

  @Put('push-subscriptions')
  upsertSubscription(
    @Headers('x-user-id') header: unknown,
    @Body() body: { token?: unknown; platform?: unknown },
  ) {
    if (typeof body.token !== 'string' || typeof body.platform !== 'string')
      throw new BadRequestException('token and platform are required');
    return this.subscriptions.upsert(
      requireUserId(header),
      body.token,
      body.platform as PushPlatform,
    );
  }

  @Delete('push-subscriptions')
  async deleteSubscription(
    @Headers('x-user-id') header: unknown,
    @Body() body: { token?: unknown },
  ): Promise<void> {
    if (typeof body.token !== 'string')
      throw new BadRequestException('token is required');
    await this.subscriptions.remove(requireUserId(header), body.token);
  }
}

function requireUserId(value: unknown): string {
  // Gateway가 아직 검증된 사용자 문맥을 전달하지 않으므로 운영에서 헤더를 신뢰하지 않는다.
  if (process.env.NODE_ENV === 'production')
    throw new ServiceUnavailableException(
      'Notification authentication integration is unavailable',
    );
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new BadRequestException('positive decimal x-user-id is required');
  return value;
}
