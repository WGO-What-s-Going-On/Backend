import { ConfigService } from '@nestjs/config';
import type { TypeOrmModuleOptions } from '@nestjs/typeorm';

import { USER_SERVICE_ENTITIES } from './entities/index.js';

export function createTypeOrmOptions(config: ConfigService): TypeOrmModuleOptions {
  return {
    type: 'postgres',
    host: config.getOrThrow<string>('database.host'),
    port: config.getOrThrow<number>('database.port'),
    username: config.getOrThrow<string>('database.username'),
    password: config.getOrThrow<string>('database.password'),
    database: config.getOrThrow<string>('database.name'),
    entities: [...USER_SERVICE_ENTITIES],
    synchronize: false,
  };
}
