import 'reflect-metadata';

import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { DataSource } from 'typeorm';

import { configuration } from '../config/configuration.js';
import { USER_SERVICE_ENTITIES } from './entities/index.js';
import { InitialUserServiceSchema1789990707351 } from './migrations/1789990707351-InitialUserServiceSchema.js';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const database = configuration().database;

export default new DataSource({
  type: 'postgres',
  host: database.host,
  port: database.port,
  username: database.username,
  password: database.password,
  database: database.name,
  entities: [...USER_SERVICE_ENTITIES],
  migrations: [InitialUserServiceSchema1789990707351],
  synchronize: false,
});
