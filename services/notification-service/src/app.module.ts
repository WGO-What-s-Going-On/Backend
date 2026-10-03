import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';

import { configuration } from './config/configuration.js';
import { HealthModule } from './health/health.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    HealthModule,
  ],
})
export class AppModule {}
