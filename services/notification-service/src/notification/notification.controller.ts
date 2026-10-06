import { BadRequestException, Controller, Delete, Get, Headers, NotFoundException, Param, Patch, Put, Query, Body } from '@nestjs/common';

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
  list(@Headers('x-user-id') header: unknown, @Query('limit') limit?: string, @Query('cursor') cursor?: string) {
    return this.notifications.list(requireUserId(header), limit === undefined ? 20 : Number(limit), cursor);
  }

  @Patch(':notificationId/read')
  async markRead(@Headers('x-user-id') header: unknown, @Param('notificationId') notificationId: string) {
    const result = await this.notifications.markRead(requireUserId(header), notificationId);
    if (!result) throw new NotFoundException('notification not found');
    return result;
  }

  @Put('push-subscriptions')
  upsertSubscription(
    @Headers('x-user-id') header: unknown,
    @Body() body: { token?: unknown; platform?: unknown },
  ) {
    if (typeof body.token !== 'string' || typeof body.platform !== 'string') throw new BadRequestException('token and platform are required');
    return this.subscriptions.upsert(requireUserId(header), body.token, body.platform as PushPlatform);
  }

  @Delete('push-subscriptions')
  async deleteSubscription(
    @Headers('x-user-id') header: unknown,
    @Body() body: { token?: unknown },
  ): Promise<void> {
    if (typeof body.token !== 'string') throw new BadRequestException('token is required');
    await this.subscriptions.remove(requireUserId(header), body.token);
  }
}

function requireUserId(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '') throw new BadRequestException('x-user-id is required');
  return value;
}
