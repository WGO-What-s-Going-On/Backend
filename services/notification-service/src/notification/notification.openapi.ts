import { applyDecorators } from '@nestjs/common';
import {
  ApiBadRequestResponse,
  ApiBearerAuth,
  ApiHeader,
  ApiInternalServerErrorResponse,
  ApiProperty,
  ApiUnauthorizedResponse,
} from '@nestjs/swagger';
import type { SchemaObject } from '@nestjs/swagger';
import type { PushPlatform } from '../push-subscription/push-subscription.js';

// Documentation DTOs only: request validation remains in the existing handlers.
export class RegisterPushSubscriptionDto {
  @ApiProperty({
    type: String,
    description:
      'FCM registration token from the client Firebase SDK. Register again after token refresh.',
    example: 'example-fcm-registration-token',
  })
  token!: string;

  @ApiProperty({
    type: String,
    enum: ['web', 'ios', 'android'],
    example: 'web',
  })
  platform!: PushPlatform;
}

export class DeletePushSubscriptionDto {
  @ApiProperty({
    type: String,
    description:
      'FCM registration token to remove for the authenticated user, for example before logout.',
    example: 'example-fcm-registration-token',
  })
  token!: string;
}

const string = { type: 'string' } as const;
const timestamp = { type: 'string', format: 'date-time' } as const;
const nullableString = { type: 'string', nullable: true } as const;
export const notificationSchema: SchemaObject = {
  type: 'object',
  required: [
    'notificationId',
    'userId',
    'type',
    'title',
    'body',
    'actorId',
    'targetType',
    'targetId',
    'actionPath',
    'count',
    'isRead',
    'createdAt',
    'expiresAt',
  ],
  properties: {
    notificationId: {
      ...string,
      description: 'Opaque notification ID. URL-encode when used in a path.',
    },
    userId: {
      ...string,
      description: 'Recipient user ID as a decimal string.',
      example: '123',
    },
    type: {
      ...string,
      description:
        'Event type, for example POST_COMMENTED or USER_BADGE_GRANTED. Clients must tolerate new types.',
    },
    title: string,
    body: string,
    actorId: nullableString,
    targetType: nullableString,
    targetId: nullableString,
    actionPath: {
      ...nullableString,
      description:
        'Client navigation path when available, for example /posts/{postId}.',
    },
    count: {
      type: 'integer',
      description: 'Number of events represented by this notification.',
      example: 1,
    },
    isRead: { type: 'boolean' },
    createdAt: timestamp,
    expiresAt: {
      type: 'integer',
      description: 'Expiration time in Unix seconds (not milliseconds).',
      example: 1796083200,
    },
    commentId: {
      ...string,
      description:
        'Optional related comment ID. Omitted for events without a comment.',
    },
    metadata: {
      type: 'object',
      additionalProperties: true,
      description:
        'Optional event-specific data. Keys and value types vary by event; tolerate missing and unknown keys. Examples include badgeId/badgeCode, level/previousLevel, reportId/targetType and vote results.',
      example: { level: 3, previousLevel: 2, changeType: 'UP' },
    },
  },
};

export const notificationPageSchema: SchemaObject = {
  type: 'object',
  required: ['items'],
  properties: {
    items: { type: 'array', items: notificationSchema },
    nextCursor: {
      ...string,
      description:
        'Opaque cursor for the next page. Omitted on the last page; pass unchanged as cursor.',
    },
  },
};

export const preferencesSchema: SchemaObject = {
  type: 'object',
  required: [
    'nearby',
    'replies',
    'reactions',
    'lifecycle',
    'rewards',
    'votes',
    'moderation',
  ],
  properties: Object.fromEntries(
    [
      'nearby',
      'replies',
      'reactions',
      'lifecycle',
      'rewards',
      'votes',
      'moderation',
    ].map((key) => [key, { type: 'boolean', default: true }]),
  ),
};

export const boardRequestSchema: SchemaObject = {
  type: 'object',
  required: ['enabled'],
  additionalProperties: false,
  properties: { enabled: { type: 'boolean', example: false } },
};
export const boardSchema: SchemaObject = {
  type: 'object',
  required: ['postId', 'enabled'],
  properties: { postId: string, enabled: { type: 'boolean', default: true } },
};
export const nearbySchema: SchemaObject = {
  type: 'object',
  required: [
    'featureEnabled',
    'enabled',
    'locationConsent',
    'expiresAt',
    'radiusM',
  ],
  properties: {
    featureEnabled: {
      type: 'boolean',
      description: 'Server feature flag, independent of the user preference.',
    },
    enabled: { type: 'boolean' },
    locationConsent: { type: 'boolean' },
    expiresAt: {
      ...timestamp,
      nullable: true,
      description: 'Null when no active subscription exists.',
    },
    radiusM: {
      type: 'integer',
      enum: [150],
      description: 'Fixed nearby radius in meters.',
    },
  },
};

export const pushSubscriptionSchema: SchemaObject = {
  type: 'object',
  required: [
    'userId',
    'token',
    'platform',
    'createdAt',
    'updatedAt',
    'lastSeenAt',
  ],
  properties: {
    userId: string,
    token: string,
    platform: { type: 'string', enum: ['web', 'ios', 'android'] },
    createdAt: timestamp,
    updatedAt: timestamp,
    lastSeenAt: timestamp,
  },
};

export const notificationErrorSchema: SchemaObject = {
  type: 'object',
  required: ['statusCode', 'message'],
  properties: {
    statusCode: { type: 'integer' },
    message: { type: 'string', example: 'Invalid preferences' },
    error: {
      type: 'string',
      description: 'HTTP error name; omitted for an unhandled 500 error.',
    },
  },
};

export function ApiNotificationAuth() {
  return applyDecorators(
    ApiBearerAuth('GatewayBearer'),
    ApiHeader({
      name: 'X-User-Id',
      required: true,
      schema: { type: 'string', pattern: '^[1-9][0-9]*$' },
      description:
        'Internal Gateway identity. Local/test calls without Authorization may supply this directly. Public clients send only their Access JWT to the HTTP Gateway.',
    }),
    ApiBadRequestResponse({
      description:
        'Invalid user context, request body, query or path parameter.',
      schema: notificationErrorSchema,
    }),
    ApiUnauthorizedResponse({
      description:
        'Missing or invalid signed Gateway identity in production, or invalid supplied identity in local/test.',
      schema: notificationErrorSchema,
    }),
    ApiInternalServerErrorResponse({
      description: 'Unhandled service or storage error.',
      schema: notificationErrorSchema,
    }),
  );
}
