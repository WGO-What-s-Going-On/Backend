import { ReportsModule } from './reports/reports.module.js';
import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { configuration } from './config/configuration.js';
import { HealthModule } from './health/health.module.js';
import { EventConsumerModule } from './event-consumer/event-consumer.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    HealthModule,
    ReportsModule,
    EventConsumerModule,
  ],
})
export class AppModule {}
