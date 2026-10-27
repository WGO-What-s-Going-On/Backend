import { ConfigService } from '@nestjs/config';
import { RedisModerationResultRepository } from '../dist/content-moderation/redis-moderation-result.repository.js';

const eventId = process.argv[2];
if (
  !process.env.REDIS_URL ||
  !eventId ||
  !/^evt_[A-Za-z0-9_-]{1,180}$/.test(eventId) ||
  process.argv.length !== 3
)
  throw new Error('Explicit REDIS_URL and one source eventId are required');
const repository = new RedisModerationResultRepository(
  new ConfigService({
    redis: {
      url: process.env.REDIS_URL,
      contentEventStream:
        process.env.MODERATION_CONTENT_EVENT_STREAM ??
        'moderation:content-events',
    },
  }),
);
try {
  await repository.republish(eventId);
  console.log(
    'Stored evaluation republished with its original output event ID.',
  );
} catch {
  console.error(
    'Republish failed or retained result is unavailable; no re-evaluation was requested.',
  );
  process.exitCode = 1;
} finally {
  await repository.onModuleDestroy();
}
