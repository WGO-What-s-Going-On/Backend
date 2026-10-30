import { ActivateWgoTitles1793400000000 } from './migrations/1793400000000-ActivateWgoTitles.js';
import { CompleteActivityRewards1793360000000 } from './migrations/1793360000000-CompleteActivityRewards.js';
import 'reflect-metadata';
import { AddPrivateRealName1793200000000 } from './migrations/1793200000000-AddPrivateRealName.js';

import { existsSync } from 'node:fs';
import { loadEnvFile } from 'node:process';

import { DataSource } from 'typeorm';

import { configuration } from '../config/configuration.js';
import { USER_SERVICE_ENTITIES } from './entities/index.js';
import { InitialUserServiceSchema1789990707351 } from './migrations/1789990707351-InitialUserServiceSchema.js';
import { AddTermsCodeEffectiveAtIndex1789993249262 } from './migrations/1789993249262-AddTermsCodeEffectiveAtIndex.js';
import { AddActivityRewards1792190000000 } from './migrations/1792190000000-AddActivityRewards.js';

if (existsSync('.env')) {
  loadEnvFile('.env');
}

const database = configuration().database;

export default new DataSource({
  type: 'postgres',
  ssl: database.ssl,
  host: database.host,
  port: database.port,
  username: database.username,
  password: database.password,
  database: database.name,
  entities: [...USER_SERVICE_ENTITIES],
  migrations: [
    AddPrivateRealName1793200000000,
    InitialUserServiceSchema1789990707351,
    AddTermsCodeEffectiveAtIndex1789993249262,
    AddActivityRewards1792190000000,
    CompleteActivityRewards1793360000000,
    ActivateWgoTitles1793400000000,
  ],
  synchronize: false,
});
