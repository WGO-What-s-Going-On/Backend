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
import { ApiBody, ApiOperation, ApiOkResponse, ApiTags } from '@nestjs/swagger';
import { GatewayAuthGuard } from '../gateway-auth.js';
import { requireUserId } from './notification.controller.js';
import { NearbySubscriptionService } from './nearby-subscription.service.js';

@UseGuards(GatewayAuthGuard)
@ApiTags('Notifications')
@Controller('api/v1/notifications/nearby-subscription')
export class NearbyController {
  constructor(private readonly subscriptions: NearbySubscriptionService) {}
  @Get()
  @ApiOperation({
    summary:
      'Read my explicit nearby subscription without returning coordinates',
  })
  @ApiOkResponse({
    schema: {
      type: 'object',
      properties: {
        featureEnabled: { type: 'boolean' },
        enabled: { type: 'boolean' },
        locationConsent: { type: 'boolean' },
        expiresAt: { type: 'string', nullable: true, format: 'date-time' },
        radiusM: { type: 'integer', enum: [150] },
      },
    },
  })
  get(@Headers('x-user-id') id: unknown) {
    return this.subscriptions.get(requireUserId(id));
  }
  @Put()
  @ApiOperation({
    summary:
      'Opt in separately to nearby alerts and location use; maximum location TTL 15 minutes',
    description:
      'No participation, terms consent or stored home region is reused as location consent. Feature defaults OFF. Renew with a fresh measured location.',
  })
  @ApiBody({
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
  remove(@Headers('x-user-id') id: unknown) {
    return this.subscriptions.remove(requireUserId(id));
  }
}
