import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import type { UpdateUserProfile, UserProfileResponse } from './dto/user-profile.dto.js';

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

  async getProfile(userId: string): Promise<UserProfileResponse> {
    const user = await this.usersRepository.findOneBy({ id: userId });
    if (!user) throw new NotFoundException('User not found');
    return toProfile(user);
  }

  async updateProfile(userId: string, input: UpdateUserProfile): Promise<UserProfileResponse> {
    try {
      return await this.usersRepository.manager.transaction(async (manager) => {
        const users = manager.getRepository(UserEntity);
        const user = await users.findOne({ where: { id: userId }, lock: { mode: 'pessimistic_write' } });
        if (!user) throw new NotFoundException('User not found');
        const wasOnboarding = user.onboardingCompletedAt === null;
        const completesOnboarding = wasOnboarding && input.nickname !== undefined;
        if (input.nickname !== undefined) {
          const duplicated = await users.createQueryBuilder('user')
            .where('LOWER(user.nickname) = LOWER(:nickname)', { nickname: input.nickname })
            .andWhere('user.id <> :userId', { userId })
            .getExists();
          if (duplicated) throw new ConflictException('Nickname is already in use');
        }
        const changed = (input.nickname !== undefined && input.nickname !== user.nickname) ||
          (input.profileImageKey !== undefined && input.profileImageKey !== user.profileImageKey);
        if (!changed && !completesOnboarding) return toProfile(user);
        const now = new Date();
        if (input.nickname !== undefined) user.nickname = input.nickname;
        if (input.profileImageKey !== undefined) user.profileImageKey = input.profileImageKey;
        if (completesOnboarding) user.onboardingCompletedAt = now;
        user.updatedAt = now;
        await users.save(user);

        if (completesOnboarding || !wasOnboarding) {
          const eventId = randomUUID();
          const eventType = completesOnboarding ? 'USER_CREATED' : 'USER_PROFILE_UPDATED';
          await manager.getRepository(OutboxEventEntity).insert({
            eventId, aggregateId: user.id, eventType,
            payload: {
              eventId, type: eventType, target: { type: 'USER', id: user.id },
              occurredAt: now.toISOString(), version: 1,
              payload: { userId: user.id, nickname: user.nickname, profileImageKey: user.profileImageKey },
            },
            status: 'PENDING', publishAttempts: 0, createdAt: now, publishedAt: null,
          });
        }
        return toProfile(user);
      });
    } catch (error) {
      if (error instanceof QueryFailedError && error.driverError?.code === '23505' &&
          error.driverError?.constraint === 'uq_users_nickname_lower') {
        throw new ConflictException('Nickname is already in use');
      }
      throw error;
    }
  }
}

function toProfile(user: UserEntity): UserProfileResponse {
  return {
    userId: user.id, nickname: user.nickname, profileImageKey: user.profileImageKey,
    status: user.status, onboardingRequired: user.onboardingCompletedAt === null,
    createdAt: user.createdAt.toISOString(),
  };
}
