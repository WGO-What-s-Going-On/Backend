import { Controller, Get } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { UserLiveness } from '../http.openapi.js';

@ApiTags('Health')
@Controller('health')
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: 'User service liveness' })
  @ApiResponse({ status: 200, type: UserLiveness })
  liveness() {
    return {
      service: 'user-service',
      status: 'ok',
    } as const;
  }
}
