import { Optional } from '@nestjs/common';
import { DynamoDbEventStore } from '../persistence/dynamodb-event.store.js';
import { HttpCode } from '@nestjs/common';
import { ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { UseGuards } from '@nestjs/common';
import { GatewayAuthGuard } from '../gateway-auth.js';
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
} from '@nestjs/common';

import { NotificationService } from './notification.service.js';
import { PushSubscriptionService } from '../push-subscription/push-subscription.service.js';
import type { PushPlatform } from '../push-subscription/push-subscription.js';

@UseGuards(GatewayAuthGuard)
@ApiTags('Notifications')
@Controller('api/v1/notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly subscriptions: PushSubscriptionService,
    @Optional() private readonly settings?: DynamoDbEventStore,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Notification type preferences' })
  preferences(@Headers('x-user-id') header: unknown) {
    return this.settings!.preferences(requireUserId(header));
  }
  @Patch('settings')
  @ApiOperation({
    summary: 'Update notification type preferences',
    description: 'Partial booleans: nearby, replies, reactions, lifecycle.',
  })
  savePreferences(
    @Headers('x-user-id') header: unknown,
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      !Object.keys(body).length ||
      Object.entries(body).some(
        ([key, value]) =>
          !['nearby', 'replies', 'reactions', 'lifecycle'].includes(key) ||
          typeof value !== 'boolean',
      )
    )
      throw new BadRequestException('Invalid preferences');
    return this.settings!.savePreferences(
      requireUserId(header),
      body as Record<string, boolean>,
    );
  }
  @Get('boards/:postId')
  @ApiOperation({ summary: 'Board notification preference' })
  board(@Headers('x-user-id') header: unknown, @Param('postId') id: string) {
    return this.settings!.boardPreference(requireUserId(header), boardId(id));
  }
  @Put('boards/:postId')
  @ApiOperation({ summary: 'Enable or mute notifications for a board' })
  setBoard(
    @Headers('x-user-id') header: unknown,
    @Param('postId') id: string,
    @Body() body: unknown,
  ) {
    if (
      !body ||
      typeof body !== 'object' ||
      Array.isArray(body) ||
      Object.keys(body).length !== 1 ||
      !('enabled' in body) ||
      typeof body.enabled !== 'boolean'
    )
      throw new BadRequestException('enabled boolean required');
    return this.settings!.setBoardPreference(
      requireUserId(header),
      boardId(id),
      body.enabled,
    );
  }
  @Patch('read-all')
  @ApiOperation({
    summary: 'Mark a page of notifications read',
    description:
      'Processes up to 100. Repeat with nextCursor until null; repeated requests are safe.',
  })
  markAll(
    @Headers('x-user-id') header: unknown,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.markAllRead(requireUserId(header), cursor);
  }

  @Get()
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['items'],
      properties: {
        items: {
          type: 'array',
          items: {
            type: 'object',
            required: [
              'notificationId',
              'type',
              'title',
              'body',
              'isRead',
              'createdAt',
            ],
            properties: {
              notificationId: { type: 'string' },
              type: { type: 'string' },
              title: { type: 'string' },
              body: { type: 'string' },
              isRead: { type: 'boolean' },
              createdAt: { type: 'string', format: 'date-time' },
              targetId: { type: 'string', nullable: true },
              actionPath: { type: 'string', nullable: true },
              count: { type: 'integer' },
            },
          },
        },
        nextCursor: { type: 'string' },
      },
    },
  })
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
  @Delete(':notificationId')
  @HttpCode(204)
  @ApiOperation({ summary: 'Delete own notification' })
  remove(
    @Headers('x-user-id') header: unknown,
    @Param('notificationId') id: string,
  ) {
    return this.notifications.remove(requireUserId(header), id);
  }
}

function requireUserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new BadRequestException('positive decimal x-user-id is required');
  return value;
}

function boardId(value: string): string {
  if (!/^post_[0-9a-f-]{36}$/.test(value))
    throw new BadRequestException('Invalid postId');
  return value;
}
