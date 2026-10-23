import { Module } from '@nestjs/common';

import { ContentModerationModule } from '../content-moderation/content-moderation.module.js';
import { LifecycleModule } from '../lifecycle/lifecycle.module.js';
import { ModerationPostEventProcessor } from './moderation-post-event.processor.js';
import { PostEventConsumer } from './post-event.consumer.js';
import { POST_EVENT_PROCESSOR } from './post-event.processor.js';

@Module({
  imports: [ContentModerationModule, LifecycleModule],
  providers: [
    ModerationPostEventProcessor,
    {
      provide: POST_EVENT_PROCESSOR,
      useExisting: ModerationPostEventProcessor,
    },
    PostEventConsumer,
  ],
})
export class EventConsumerModule {}
