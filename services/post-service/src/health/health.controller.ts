import { Controller, Get } from '@nestjs/common';
import { ApiOkResponse, ApiOperation, ApiTags } from '@nestjs/swagger';
import { LivenessResponse } from './health.openapi.js';

@Controller('health')
@ApiTags('Health')
export class HealthController {
  @Get('live')
  @ApiOperation({ summary: '프로세스 생존 확인', description: '데이터베이스 연결 상태는 확인하지 않습니다.' })
  @ApiOkResponse({ type: LivenessResponse })
  liveness() {
    return {
      service: 'post-service',
      status: 'ok',
    } as const;
  }
}
