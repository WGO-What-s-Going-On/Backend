import { Optional } from '@nestjs/common';
import { PostgresEventStore } from '../persistence/postgres-event.store.js';
import { HttpCode } from '@nestjs/common';
import {
  ApiOperation,
  ApiOkResponse,
  ApiTags,
  ApiBody,
  ApiNoContentResponse,
  ApiNotFoundResponse,
  ApiParam,
  ApiQuery,
} from '@nestjs/swagger';
import {
  ApiNotificationAuth,
  RegisterPushSubscriptionDto,
  DeletePushSubscriptionDto,
  notificationSchema,
  notificationPageSchema,
  preferencesSchema,
  boardSchema,
  boardRequestSchema,
  pushSubscriptionSchema,
  notificationErrorSchema,
} from './notification.openapi.js';
import { NotificationPreferencesPatch } from './preferences.dto.js';
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
@ApiNotificationAuth()
@Controller('api/v1/notifications')
export class NotificationController {
  constructor(
    private readonly notifications: NotificationService,
    private readonly subscriptions: PushSubscriptionService,
    @Optional() private readonly settings?: PostgresEventStore,
  ) {}

  @Get('settings')
  @ApiOperation({ summary: 'Notification type preferences' })
  @ApiOkResponse({
    description:
      'All seven preferences; unset values default to true. nearby=true alone does not grant location consent or create a nearby subscription.',
    schema: preferencesSchema,
  })
  preferences(@Headers('x-user-id') header: unknown) {
    return this.settings!.preferences(requireUserId(header));
  }
  @Patch('settings')
  @ApiBody({
    type: NotificationPreferencesPatch,
    required: true,
    description:
      'Non-empty partial object of boolean preferences. Unknown keys are rejected. Omitted keys keep their current values.',
    examples: {
      muteReplies: { value: { replies: false } },
      enableAll: {
        value: {
          nearby: true,
          replies: true,
          reactions: true,
          lifecycle: true,
          rewards: true,
          votes: true,
          moderation: true,
        },
      },
    },
  })
  @ApiOkResponse({
    description: 'Complete preferences after applying the patch.',
    schema: preferencesSchema,
  })
  @ApiOperation({
    summary: 'Update notification type preferences',
    description:
      'Partial booleans: nearby, replies, reactions, lifecycle, rewards, votes, moderation. False suppresses new inbox entries and push.',
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
          ![
            'nearby',
            'replies',
            'reactions',
            'lifecycle',
            'rewards',
            'votes',
            'moderation',
          ].includes(key) || typeof value !== 'boolean',
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
  @ApiParam({
    name: 'postId',
    schema: { type: 'string', pattern: '^post_[0-9a-f-]{36}$' },
  })
  @ApiOkResponse({
    description: 'Board preference; enabled defaults to true.',
    schema: boardSchema,
  })
  board(@Headers('x-user-id') header: unknown, @Param('postId') id: string) {
    return this.settings!.boardPreference(requireUserId(header), boardId(id));
  }
  @Put('boards/:postId')
  @ApiOperation({ summary: 'Enable or mute notifications for a board' })
  @ApiParam({
    name: 'postId',
    schema: { type: 'string', pattern: '^post_[0-9a-f-]{36}$' },
  })
  @ApiBody({ required: true, schema: boardRequestSchema })
  @ApiOkResponse({
    description: 'Saved board preference.',
    schema: boardSchema,
  })
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
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description: 'Opaque cursor from the preceding read-all response.',
  })
  @ApiOkResponse({
    description:
      'Processed page; nextCursor is explicitly null on the last page.',
    schema: {
      type: 'object',
      required: ['processed', 'nextCursor'],
      properties: {
        processed: {
          type: 'integer',
          minimum: 0,
          maximum: 100,
          description: 'Number of items scanned, including items already read.',
        },
        nextCursor: { type: 'string', nullable: true },
      },
    },
  })
  markAll(
    @Headers('x-user-id') header: unknown,
    @Query('cursor') cursor?: string,
  ) {
    return this.notifications.markAllRead(requireUserId(header), cursor);
  }

  @Get()
  @ApiOperation({
    summary: 'List my notifications',
    description:
      'Newest notification IDs first. Excludes expired, deleted and zero-count entries. Use actionPath/targetId and optional commentId to navigate; metadata is event-specific.',
  })
  @ApiQuery({
    name: 'limit',
    required: false,
    schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
  })
  @ApiQuery({
    name: 'cursor',
    required: false,
    type: String,
    description:
      'Opaque nextCursor from the previous page. Omit for the first page.',
  })
  @ApiOkResponse({
    description:
      'Notification page. nextCursor is omitted when there are no more items.',
    schema: notificationPageSchema,
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
  @ApiOperation({ summary: 'Count my unread notifications' })
  @ApiOkResponse({
    schema: {
      type: 'object',
      required: ['count'],
      properties: { count: { type: 'integer', minimum: 0, example: 3 } },
    },
  })
  async unread(@Headers('x-user-id') header: unknown) {
    return { count: await this.notifications.unread(requireUserId(header)) };
  }

  @Patch(':notificationId/read')
  @ApiOperation({
    summary: 'Mark my notification read',
    description:
      'Returns the complete notification, including optional commentId and metadata.',
  })
  @ApiParam({
    name: 'notificationId',
    type: String,
    description: 'URL-encoded opaque notificationId from the list.',
  })
  @ApiOkResponse({
    description: 'Notification with isRead=true.',
    schema: notificationSchema,
  })
  @ApiNotFoundResponse({
    description: 'Notification does not exist for the authenticated user.',
    schema: notificationErrorSchema,
  })
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
  @ApiOperation({
    summary: 'Register or refresh an FCM token',
    description:
      'Use the Firebase SDK registration token and its platform. Re-register after token refresh; remove the old token separately when possible. A token can belong to only one user. FCM messages include notification.title/body and string-valued data: notificationId/type, optional targetId/actionPath/commentId and event-specific keys. Correlate data.notificationId with inbox items, refresh the inbox and unread count when a push arrives, and navigate using actionPath and optional commentId. Push metadata values may be flattened strings; inbox metadata retains its JSON value types. Empty/whitespace tokens, unsupported string platforms and tokens owned by another user currently produce 500; missing or non-string fields produce 400.',
  })
  @ApiBody({ type: RegisterPushSubscriptionDto, required: true })
  @ApiOkResponse({
    description:
      'Registered subscription with ISO 8601 timestamps. Re-registration refreshes updatedAt and lastSeenAt.',
    schema: pushSubscriptionSchema,
  })
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
  @ApiOperation({
    summary: 'Unregister my FCM token',
    description:
      'Send a JSON body with the token. Repeated removal is safe. Success is HTTP 200 with an empty body.',
  })
  @ApiBody({ type: DeletePushSubscriptionDto, required: true })
  @ApiOkResponse({
    description: 'Token removed or already absent. Empty response body.',
  })
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
  @ApiParam({
    name: 'notificationId',
    type: String,
    description: 'URL-encoded opaque notificationId from the list.',
  })
  @ApiNoContentResponse({
    description: 'Notification deleted or already absent. Empty response body.',
  })
  remove(
    @Headers('x-user-id') header: unknown,
    @Param('notificationId') id: string,
  ) {
    return this.notifications.remove(requireUserId(header), id);
  }
}

export function requireUserId(value: unknown): string {
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value))
    throw new BadRequestException('positive decimal x-user-id is required');
  return value;
}

function boardId(value: string): string {
  if (!/^post_[0-9a-f-]{36}$/.test(value))
    throw new BadRequestException('Invalid postId');
  return value;
}
