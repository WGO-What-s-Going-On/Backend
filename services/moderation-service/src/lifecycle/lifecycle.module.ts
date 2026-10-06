import { Module } from '@nestjs/common';

import { LIFECYCLE_REPOSITORY } from './lifecycle.repository.js';
import { LifecycleService } from './lifecycle.service.js';
import { RedisLifecycleRepository } from './redis-lifecycle.repository.js';

@Module({
  providers: [
    RedisLifecycleRepository,
    { provide: LIFECYCLE_REPOSITORY, useExisting: RedisLifecycleRepository },
    LifecycleService,
  ],
  exports: [LifecycleService],
})
export class LifecycleModule {}
