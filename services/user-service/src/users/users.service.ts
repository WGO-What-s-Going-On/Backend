import { Injectable } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';

import { UserEntity } from '../database/entities/user.entity.js';
import type { NicknameAvailabilityResponse } from './dto/nickname-availability-response.dto.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
  ) {}

  async checkNicknameAvailability(nickname: string): Promise<NicknameAvailabilityResponse> {
    const duplicated = await this.usersRepository
      .createQueryBuilder('user')
      .select('1')
      .where('LOWER(user.nickname) = LOWER(:nickname)', { nickname })
      .getExists();

    if (duplicated) {
      return { available: false, reason: 'DUPLICATED' };
    }

    return { available: true, reason: null };
  }
}
