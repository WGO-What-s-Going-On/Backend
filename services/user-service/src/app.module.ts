import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';

import { configuration } from './config/configuration.js';
import { createTypeOrmOptions } from './database/typeorm.config.js';
import { HealthModule } from './health/health.module.js';
import { TermsModule } from './terms/terms.module.js';
import { UsersModule } from './users/users.module.js';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      load: [configuration],
    }),
    TypeOrmModule.forRootAsync({
      inject: [ConfigService],
      useFactory: createTypeOrmOptions,
    }),
    HealthModule,
    TermsModule,
    UsersModule,
  ],
})
export class AppModule {}
