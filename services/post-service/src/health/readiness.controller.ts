import {
  Controller,
  Get,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectConnection } from '@nestjs/mongoose';
import { Connection } from 'mongoose';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';

@ApiTags('Health')
@Controller('health')
export class ReadinessController {
  constructor(
    @Optional() @InjectConnection() private readonly database?: Connection,
  ) {}

  @Get('ready')
  @ApiOperation({
    summary:
      'Post database readiness; model availability remains search-specific',
  })
  @ApiResponse({ status: 200, description: 'MongoDB connection is ready' })
  @ApiResponse({ status: 503, description: 'MongoDB unavailable' })
  async readiness() {
    try {
      if (this.database?.readyState === 1 && this.database.db) {
        await this.database.db.command({ ping: 1 }, { timeoutMS: 2000 });
        return { status: 'ready' };
      }
    } catch {
      // Storage errors are not part of the public health contract.
    }
    throw new ServiceUnavailableException('Post database unavailable');
  }
}
