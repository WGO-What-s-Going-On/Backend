import { Module } from '@nestjs/common';

import { LIFECYCLE_REPOSITORY } from './lifecycle.repository.js';
import { LifecycleService } from './lifecycle.service.js';
import { RedisLifecycleRepository } from './redis-lifecycle.repository.js';
import { CLOCK, SystemClock } from './clock.js';
import { LifecycleScheduler } from './lifecycle.scheduler.js';

@Module({
  providers: [
    RedisLifecycleRepository,
    { provide: LIFECYCLE_REPOSITORY, useExisting: RedisLifecycleRepository },
    LifecycleService,
    { provide: CLOCK, useClass: SystemClock },
    LifecycleScheduler,
  ],
  exports: [LifecycleService],
})
export class LifecycleModule {}
