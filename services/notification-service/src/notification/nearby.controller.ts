import {
  Body,
  Controller,
  Delete,
  Get,
  Headers,
  HttpCode,
  Put,
  UseGuards,
} from '@nestjs/common';
import {
  ApiBody,
  ApiOperation,
  ApiOkResponse,
  ApiTags,
  ApiNoContentResponse,
  ApiServiceUnavailableResponse,
} from '@nestjs/swagger';
import {
  ApiNotificationAuth,
  nearbySchema,
  notificationErrorSchema,
} from './notification.openapi.js';
import { GatewayAuthGuard } from '../gateway-auth.js';
import { requireUserId } from './notification.controller.js';
import { NearbySubscriptionService } from './nearby-subscription.service.js';

@UseGuards(GatewayAuthGuard)
@ApiTags('Notifications')
@ApiNotificationAuth()
@Controller('api/v1/notifications/nearby-subscription')
export class NearbyController {
  constructor(private readonly subscriptions: NearbySubscriptionService) {}
  @Get()
  @ApiOperation({
    summary:
      'Read my explicit nearby subscription without returning coordinates',
  })
  @ApiOkResponse({
    description: 'Current subscription. Coordinates are never returned.',
    schema: nearbySchema,
  })
  get(@Headers('x-user-id') id: unknown) {
    return this.subscriptions.get(requireUserId(id));
  }
  @Put()
  @ApiOperation({
    summary:
      'Opt in separately to nearby alerts and location use; maximum location TTL 15 minutes',
    description:
      'No participation, terms consent or stored home region is reused as location consent. Feature defaults OFF. Renew with a fresh measured location. capturedAt must be UTC ending in Z, newer than 15 minutes ago and no more than 30 seconds in the future. Expiry is the earlier of now + expiresInSeconds and capturedAt + 15 minutes. Send only {"enabled":false} to withdraw, even when the feature is disabled.',
  })
  @ApiOkResponse({
    description: 'Saved subscription state. Coordinates are never returned.',
    schema: nearbySchema,
  })
  @ApiServiceUnavailableResponse({
    description:
      'Nearby notifications are disabled on the server (enable requests only).',
    schema: notificationErrorSchema,
  })
  @ApiBody({
    required: true,
    schema: {
      oneOf: [
        {
          type: 'object',
          required: ['enabled'],
          additionalProperties: false,
          properties: { enabled: { type: 'boolean', enum: [false] } },
        },
        {
          type: 'object',
          additionalProperties: false,
          required: [
            'enabled',
            'locationConsent',
            'latitude',
            'longitude',
            'capturedAt',
          ],
          properties: {
            enabled: { type: 'boolean', enum: [true] },
            locationConsent: { type: 'boolean', enum: [true] },
            latitude: { type: 'number', minimum: -90, maximum: 90 },
            longitude: { type: 'number', minimum: -180, maximum: 180 },
            capturedAt: { type: 'string', format: 'date-time' },
            expiresInSeconds: {
              type: 'integer',
              minimum: 60,
              maximum: 900,
              default: 900,
            },
          },
        },
      ],
    },
  })
  save(@Headers('x-user-id') id: unknown, @Body() body: unknown) {
    return this.subscriptions.save(requireUserId(id), body);
  }
  @Delete()
  @HttpCode(204)
  @ApiOperation({
    summary: 'Withdraw nearby/location consent and cancel queued nearby pushes',
  })
  @ApiNoContentResponse({
    description:
      'Consent withdrawn and queued nearby pushes canceled. Empty response body.',
  })
  remove(@Headers('x-user-id') id: unknown) {
    return this.subscriptions.remove(requireUserId(id));
  }
}
