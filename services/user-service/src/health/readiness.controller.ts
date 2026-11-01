import {
  Controller,
  Get,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class ReadinessController {
  constructor(
    @Optional() @InjectDataSource() private readonly database?: DataSource,
  ) {}

  @Get('ready')
  @ApiOperation({ summary: 'User database readiness; independent of liveness' })
  @ApiResponse({ status: 200, description: 'Database connection is ready' })
  @ApiResponse({ status: 503, description: 'Database unavailable' })
  async readiness() {
    try {
      if (this.database?.isInitialized) {
        await this.database.query('SELECT 1');
        return { status: 'ready' };
      }
    } catch {
      // Backend errors may contain credentials; expose only readiness state.
    }
    throw new ServiceUnavailableException('User database unavailable');
  }
}
