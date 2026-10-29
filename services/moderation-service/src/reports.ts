import {
  BadRequestException,
  Body,
  Controller,
  Headers,
  Injectable,
  Post,
  ServiceUnavailableException,
  UseGuards,
  type OnModuleDestroy,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ApiBody, ApiCreatedResponse, ApiTags } from '@nestjs/swagger';
import { createClient } from 'redis';
import { createHash } from 'node:crypto';
import { GatewayAuthGuard } from './gateway-auth.js';

export function reportInput(raw: unknown) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throw new BadRequestException('Report object required');
  const input = raw as Record<string, unknown>;
  if (
    Object.keys(input).some(
      (k) => !['targetType', 'targetId', 'reason'].includes(k),
    ) ||
    !['POST', 'COMMENT'].includes(String(input.targetType)) ||
    typeof input.targetId !== 'string' ||
    !(
      input.targetType === 'POST'
        ? /^post_[0-9a-f-]{36}$/
        : /^comment_[0-9a-f-]{36}$/
    ).test(input.targetId) ||
    typeof input.reason !== 'string' ||
    !input.reason.trim() ||
    input.reason.trim().length > 1000
  )
    throw new BadRequestException('Invalid report');
  return {
    targetType: input.targetType as 'POST' | 'COMMENT',
    targetId: input.targetId,
    reason: input.reason.trim(),
  };
}
@Injectable()
export class ReportsService implements OnModuleDestroy {
  private readonly client;
  private connecting: Promise<unknown> | undefined;
  constructor(config: ConfigService) {
    this.client = createClient({
      url: config.get<string>('redis.url') ?? 'redis://localhost:6383',
      disableOfflineQueue: true,
      commandOptions: { timeout: 2000 },
      socket: { connectTimeout: 2000, reconnectStrategy: false },
    });
    this.client.on('error', () => undefined);
  }
  async onModuleDestroy() {
    if (this.client.isOpen) await this.client.quit();
  }
  async create(userId: string, raw: unknown) {
    if (!/^[1-9][0-9]*$/.test(userId) || !Number.isSafeInteger(Number(userId)))
      throw new BadRequestException('Invalid user');
    const input = reportInput(raw);
    const reportId = createHash('sha256')
      .update(JSON.stringify([userId, input.targetType, input.targetId]))
      .digest('hex');
    // One report per reporter and target makes retries idempotent; the first submitted reason is retained.
    try {
      if (!this.client.isOpen) {
        this.connecting ??= this.client.connect().finally(() => {
          this.connecting = undefined;
        });
        await this.connecting;
      }
      await this.client.set(
        `moderation:report:${reportId}`,
        JSON.stringify({
          reportId,
          reporterId: userId,
          ...input,
          createdAt: new Date().toISOString(),
          status: 'PENDING',
        }),
        { NX: true },
      );
      return { reportId, status: 'PENDING' };
    } catch {
      throw new ServiceUnavailableException('Report storage unavailable');
    }
  }
}
@ApiTags('Reports')
@UseGuards(GatewayAuthGuard)
@Controller('api/v1/moderation/reports')
export class ReportsController {
  constructor(private readonly reports: ReportsService) {}
  @Post()
  @ApiBody({
    schema: {
      type: 'object',
      required: ['targetType', 'targetId', 'reason'],
      additionalProperties: false,
      properties: {
        targetType: { type: 'string', enum: ['POST', 'COMMENT'] },
        targetId: { type: 'string' },
        reason: { type: 'string', minLength: 1, maxLength: 1000 },
      },
    },
  })
  @ApiCreatedResponse({
    schema: {
      type: 'object',
      properties: {
        reportId: { type: 'string' },
        status: { type: 'string', enum: ['PENDING'] },
      },
    },
  })
  create(@Headers('x-user-id') userId: string, @Body() body: unknown) {
    return this.reports.create(userId, body);
  }
}
