import {
  Controller,
  Get,
  ServiceUnavailableException,
  Optional,
} from '@nestjs/common';
import { NotificationStreamWorkers } from '../event-consumer/notification-stream.workers.js';
import {
  ApiOkResponse,
  ApiOperation,
  ApiResponse,
  ApiTags,
} from '@nestjs/swagger';
import { PostgresDatabase } from '../persistence/postgres.database.js';
import { PostEventConsumer } from '../event-consumer/post-event.consumer.js';

@ApiTags('Health')
@Controller('health')
export class NotificationReadinessController {
  constructor(
    private readonly database: PostgresDatabase,
    private readonly consumer: PostEventConsumer,
    @Optional() private readonly streams?: NotificationStreamWorkers,
  ) {}

  @Get('ready')
  @ApiOperation({
    summary:
      'Readiness requires the PostgreSQL schema and the Redis consumer connection',
  })
  @ApiOkResponse({ description: 'Dependencies are ready' })
  @ApiResponse({
    status: 503,
    description: 'A required dependency is unavailable',
  })
  async ready() {
    if (!this.consumer.isReady() || (this.streams && !this.streams.isReady()))
      throw new ServiceUnavailableException(
        'Notification dependencies are not ready',
      );
    try {
      const result = await this.database.pool.query(
        'SELECT version FROM notification_schema_versions WHERE version=4',
      );
      if (result.rowCount !== 1) throw new Error('Schema not initialized');
    } catch {
      throw new ServiceUnavailableException(
        'Notification dependencies are not ready',
      );
    }
    return { service: 'notification-service', status: 'ready' };
  }
}
