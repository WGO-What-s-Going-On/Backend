import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness() {
    return {
      service: 'moderation-service',
      status: 'ok',
    } as const;
  }
}
