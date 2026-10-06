import { Module } from '@nestjs/common';

import { PostEventConsumer } from './post-event.consumer.js';

@Module({ providers: [PostEventConsumer] })
export class EventConsumerModule {}
