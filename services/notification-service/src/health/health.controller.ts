import { Controller, Get } from '@nestjs/common';

@Controller('health')
export class HealthController {
  @Get('live')
  liveness() {
    return {
      service: 'notification-service',
      status: 'ok',
    } as const;
  }
}
