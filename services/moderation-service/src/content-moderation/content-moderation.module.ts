import { Module } from '@nestjs/common';

import { ContentModerationService } from './content-moderation.service.js';
import { MODERATION_PROVIDER } from './moderation-provider.js';
import { MODERATION_RESULT_REPOSITORY } from './moderation-result.repository.js';
import { OpenAiModerationAdapter } from './openai-moderation.adapter.js';
import { RedisModerationResultRepository } from './redis-moderation-result.repository.js';

@Module({
  providers: [
    OpenAiModerationAdapter,
    RedisModerationResultRepository,
    { provide: MODERATION_PROVIDER, useExisting: OpenAiModerationAdapter },
    {
      provide: MODERATION_RESULT_REPOSITORY,
      useExisting: RedisModerationResultRepository,
    },
    ContentModerationService,
  ],
  exports: [ContentModerationService, RedisModerationResultRepository],
})
export class ContentModerationModule {}
