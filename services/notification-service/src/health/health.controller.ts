import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get('live')
  @ApiOperation({
    summary: 'Liveness only; no external dependency readiness check',
  })
  @ApiResponse({
    status: 200,
    schema: {
      type: 'object',
      required: ['service', 'status'],
      properties: {
        service: { type: 'string', enum: ['notification-service'] },
        status: { type: 'string', enum: ['ok'] },
      },
    },
  })
  liveness() {
    return {
      service: 'notification-service',
      status: 'ok',
    } as const;
  }
}
