import { Controller, Get, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PostEventConsumer } from './post-event.consumer.js';
import { RedisModerationResultRepository } from '../content-moderation/redis-moderation-result.repository.js';
import { RedisLifecycleRepository } from '../lifecycle/redis-lifecycle.repository.js';

@Controller('health')
export class ModerationReadinessController {
  constructor(
    private readonly config: ConfigService,
    private readonly consumer: PostEventConsumer,
    private readonly results: RedisModerationResultRepository,
    private readonly lifecycle: RedisLifecycleRepository,
  ) {}
  @Get('ready')
  async readiness() {
    try {
      if (
        this.config.get<string>('redis.url') &&
        this.config.get<string>('openai.apiKey')
      ) {
        const checks = await Promise.all([
          this.consumer.ready(),
          this.results.ready(),
          this.lifecycle.ready(),
        ]);
        if (checks.every(Boolean)) return { status: 'ready' };
      }
    } catch {
      /* Never expose credentials or backend errors in readiness responses. */
    }
    throw new ServiceUnavailableException(
      'Moderation dependencies unavailable',
    );
  }
}
