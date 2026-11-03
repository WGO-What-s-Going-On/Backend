import { ProfileImageController } from './profile-image/profile-image.controller.js';
import { ProfileImageService } from './profile-image/profile-image.service.js';
import { GcsProfileImageStorage } from './profile-image/gcs-profile-image.storage.js';
import { ProfileImageCleanupWorker } from './profile-image/profile-image.worker.js';
import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { UserEntity } from '../database/entities/user.entity.js';
import { AuthModule } from '../auth/auth.module.js';
import { UsersController } from './users.controller.js';
import { UsersService } from './users.service.js';
import { NotificationBlocksController } from './notification-blocks.controller.js';

@Module({
  imports: [TypeOrmModule.forFeature([UserEntity]), AuthModule],
  controllers: [
    UsersController,
    ProfileImageController,
    NotificationBlocksController,
  ],
  providers: [
    UsersService,
    ProfileImageService,
    GcsProfileImageStorage,
    ProfileImageCleanupWorker,
  ],
})
export class UsersModule {}
