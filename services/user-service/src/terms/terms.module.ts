import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';

import { TermEntity } from '../database/entities/term.entity.js';
import { TermsController } from './terms.controller.js';
import { TermsService } from './terms.service.js';

@Module({
  imports: [TypeOrmModule.forFeature([TermEntity])],
  controllers: [TermsController],
  providers: [TermsService],
})
export class TermsModule {}
