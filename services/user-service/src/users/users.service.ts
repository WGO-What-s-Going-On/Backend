import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { In, QueryFailedError, Repository } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
import type {
  UpdateUserProfile,
  UserProfileResponse,
} from './dto/user-profile.dto.js';

import { UserEntity, UserStatus } from '../database/entities/user.entity.js';
import { RedisSessionStore } from '../auth/redis-session.store.js';
import type { WithdrawalResponse } from './dto/withdrawal-response.dto.js';
import type { NicknameAvailabilityResponse } from './dto/nickname-availability-response.dto.js';
import { TermEntity } from '../database/entities/term.entity.js';
import { UserTermConsentEntity } from '../database/entities/user-term-consent.entity.js';
import { UserBadgeEntity } from '../database/entities/user-badge.entity.js';
import type { TermConsentsResponse } from './dto/term-consents.dto.js';
import type { UserBadgesResponse } from './dto/user-badges-response.dto.js';
import { UserBlockEntity } from '../database/entities/user-block.entity.js';
import { parseBlockPage, type BlockPage } from './dto/user-block.dto.js';

@Injectable()
export class UsersService {
  constructor(
    @InjectRepository(UserEntity)
    private readonly usersRepository: Repository<UserEntity>,
    private readonly redisSessionStore: RedisSessionStore,
  ) {}

  async changeBlock(
    userId: string,
    targetId: string,
    create: boolean,
    correlationId = randomUUID(),
  ): Promise<void> {
    if (userId === targetId)
      throw new BadRequestException('Cannot block yourself');
    await this.usersRepository.manager.transaction(async (manager) => {
      // Lock even an absent relationship through its owner rows. Ordering also
      // prevents reciprocal blocks from acquiring user locks in opposite order.
      const users = await manager
        .getRepository(UserEntity)
        .createQueryBuilder('user')
        .where('user.id IN (:...ids)', { ids: [userId, targetId] })
        .orderBy('user.id', 'ASC')
        .setLock('pessimistic_write')
        .getMany();
      const owner = users.find((user) => user.id === userId);
      if (!owner) throw new NotFoundException('User not found');
      if (owner.status !== UserStatus.ACTIVE)
        throw new ForbiddenException('Active account required');
      const target = users.find((user) => user.id === targetId);
      const blocks = manager.getRepository(UserBlockEntity);
      const existing = await blocks.findOneBy({
        blockerUserId: userId,
        blockedUserId: targetId,
      });
      if (create && existing) return;
      if (!create && !existing) return;
      if (
        create &&
        (!target ||
          ![UserStatus.ACTIVE, UserStatus.SUSPENDED].includes(target.status))
      )
        throw new NotFoundException('Block target not found');
      const now = new Date();
      if (create)
        await blocks.insert({
          blockerUserId: userId,
          blockedUserId: targetId,
          createdAt: now,
        });
      else
        await blocks.delete({ blockerUserId: userId, blockedUserId: targetId });
      const eventId = randomUUID();
      const type = create ? 'USER_BLOCK_CREATED' : 'USER_BLOCK_REMOVED';
      await manager.getRepository(OutboxEventEntity).insert({
        eventId,
        aggregateId: userId,
        eventType: type,
        payload: {
          eventId,
          type,
          target: { type: 'USER', id: userId },
          occurredAt: now.toISOString(),
          version: 1,
          producer: 'user-service',
          correlationId,
          payload: { blockerUserId: userId, blockedUserId: targetId },
        },
        status: 'PENDING',
        publishAttempts: 0,
        createdAt: now,
        publishedAt: null,
      });
    });
  }

  async listBlocks(
    userId: string,
    cursor: unknown,
    limit: unknown,
  ): Promise<BlockPage> {
    const { before, size, direction } = parseBlockPage(userId, cursor, limit);
    if (!(await this.usersRepository.existsBy({ id: userId })))
      throw new NotFoundException('User not found');
    // The existing composite PK supports this owner-scoped keyset scan.
    const query = this.usersRepository.manager
      .getRepository(UserBlockEntity)
      .createQueryBuilder('block')
      .innerJoinAndSelect('block.blockedUser', 'target')
      .where('block.blockerUserId = :userId', { userId });
    if (before)
      query.andWhere(
        direction === 'ASC'
          ? 'block.blockedUserId > :before'
          : 'block.blockedUserId < :before',
        { before },
      );
    const rows = await query
      .orderBy('block.blockedUserId', direction)
      .take(size + 1)
      .getMany();
    const page = rows.slice(0, size);
    return {
      items: page.map((row) => ({
        userId: row.blockedUserId,
        nickname: row.blockedUser.nickname,
        profileImageKey: row.blockedUser.profileImageKey,
        blockedAt: row.createdAt.toISOString(),
        createdAt: row.createdAt.toISOString(),
      })),
      nextCursor:
        rows.length > size
          ? Buffer.from(
              JSON.stringify({
                owner: userId,
                direction,
                before: page.at(-1)!.blockedUserId,
              }),
            ).toString('base64url')
          : null,
    };
  }

  async checkNicknameAvailability(
    nickname: string,
  ): Promise<NicknameAvailabilityResponse> {
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

  async consentToTerms(
    userId: string,
    termIds: string[],
  ): Promise<TermConsentsResponse> {
    return this.usersRepository.manager.transaction(async (manager) => {
      const user = await manager.getRepository(UserEntity).findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('User not found');

      // Same effective-term selection and tie-breaker as GET /api/v1/terms.
      const currentTerms = await manager
        .getRepository(TermEntity)
        .createQueryBuilder('term')
        .distinctOn(['term.code'])
        .where('term.effectiveAt <= CURRENT_TIMESTAMP')
        .orderBy('term.code', 'ASC')
        .addOrderBy('term.effectiveAt', 'DESC')
        .addOrderBy('term.id', 'DESC')
        .getMany();
      const currentIds = new Set(currentTerms.map((term) => term.id));
      const requestedIds = new Set(termIds);
      if (termIds.some((id) => !currentIds.has(id))) {
        throw new BadRequestException(
          'Only current effective term IDs may be accepted',
        );
      }
      if (
        currentTerms.some((term) => term.required && !requestedIds.has(term.id))
      ) {
        throw new BadRequestException(
          'All current required terms must be included',
        );
      }

      const consents = manager.getRepository(UserTermConsentEntity);
      const existing = await consents.findBy({ userId, termId: In(termIds) });
      const byTermId = new Map(
        existing.map((consent) => [consent.termId, consent]),
      );
      const now = new Date();
      const changes: UserTermConsentEntity[] = [];
      for (const termId of termIds) {
        const consent = byTermId.get(termId);
        if (consent && consent.revokedAt === null) continue;
        changes.push(
          consents.create({
            ...consent,
            userId,
            termId,
            agreedAt: now,
            revokedAt: null,
          }),
        );
      }
      if (changes.length) await consents.save(changes);
      return { termIds };
    });
  }

  async getBadges(userId: string): Promise<UserBadgesResponse> {
    if (!(await this.usersRepository.existsBy({ id: userId }))) {
      throw new NotFoundException('User not found');
    }
    const grants = await this.usersRepository.manager
      .getRepository(UserBadgeEntity)
      .createQueryBuilder('grant')
      .innerJoinAndSelect('grant.badge', 'badge')
      .where('grant.userId = :userId', { userId })
      .andWhere('grant.revokedAt IS NULL')
      .andWhere('badge.active = :active', { active: true })
      .orderBy('grant.grantedAt', 'DESC')
      .addOrderBy('grant.badgeId', 'DESC')
      .getMany();
    return {
      badges: grants.map(({ badge, grantedAt }) => ({
        badgeId: badge.id,
        code: badge.code,
        name: badge.name,
        description: badge.description,
        imageKey: badge.imageKey,
        grantedAt: grantedAt.toISOString(),
      })),
    };
  }

  async requestWithdrawal(
    userId: string,
    correlationId: string = randomUUID(),
  ): Promise<WithdrawalResponse> {
    return this.usersRepository.manager.transaction(async (manager) => {
      const users = manager.getRepository(UserEntity);
      const user = await users.findOne({
        where: { id: userId },
        lock: { mode: 'pessimistic_write' },
      });
      if (!user) throw new NotFoundException('User not found');
      if (
        user.status !== UserStatus.ACTIVE &&
        user.status !== UserStatus.WITHDRAWAL_PENDING
      ) {
        throw new ConflictException('Account cannot request withdrawal');
      }

      if (user.status === UserStatus.ACTIVE) {
        const now = new Date();
        user.status = UserStatus.WITHDRAWAL_PENDING;
        user.withdrawalRequestedAt = now;
        user.withdrawalDeadlineAt = new Date(
          now.getTime() + 30 * 24 * 60 * 60 * 1000,
        );
        user.updatedAt = now;
        await users.save(user);
        const eventId = randomUUID();
        const eventType = 'USER_WITHDRAWAL_STARTED';
        await manager.getRepository(OutboxEventEntity).insert({
          eventId,
          aggregateId: user.id,
          eventType,
          payload: {
            eventId,
            type: eventType,
            target: { type: 'USER', id: user.id },
            occurredAt: now.toISOString(),
            version: 1,
            producer: 'user-service',
            correlationId,
            payload: {
              userId: user.id,
              recoverableUntil: user.withdrawalDeadlineAt.toISOString(),
            },
          },
          status: 'PENDING',
          publishAttempts: 0,
          createdAt: now,
          publishedAt: null,
        });
      }
      if (!user.withdrawalDeadlineAt)
        throw new ConflictException('Withdrawal deadline is missing');

      // Keep the user lock through Redis cleanup and DB commit. A Redis failure rolls back
      // the transition; a later commit failure may log the user out but cannot enable refresh.
      // Repeated requests also clean up any stale sessions without extending the deadline.
      await this.redisSessionStore
        .deleteAllSessionsForUser(user.id)
        .catch(() => {
          throw new ServiceUnavailableException(
            'Authentication session is temporarily unavailable',
          );
        });
      return {
        status: 'WITHDRAWAL_PENDING',
        recoverableUntil: user.withdrawalDeadlineAt.toISOString(),
      };
    });
  }

  async updateProfile(
    userId: string,
    input: UpdateUserProfile,
    correlationId: string = randomUUID(),
  ): Promise<UserProfileResponse> {
    try {
      return await this.usersRepository.manager.transaction(async (manager) => {
        const users = manager.getRepository(UserEntity);
        const user = await users.findOne({
          where: { id: userId },
          lock: { mode: 'pessimistic_write' },
        });
        if (!user) throw new NotFoundException('User not found');
        const wasOnboarding = user.onboardingCompletedAt === null;
        const completesOnboarding =
          wasOnboarding && input.nickname !== undefined;
        if (input.nickname !== undefined) {
          const duplicated = await users
            .createQueryBuilder('user')
            .where('LOWER(user.nickname) = LOWER(:nickname)', {
              nickname: input.nickname,
            })
            .andWhere('user.id <> :userId', { userId })
            .getExists();
          if (duplicated)
            throw new ConflictException('Nickname is already in use');
        }
        const changed =
          (input.realName !== undefined && input.realName !== user.realName) ||
          (input.nickname !== undefined && input.nickname !== user.nickname) ||
          (input.profileImageKey !== undefined &&
            input.profileImageKey !== user.profileImageKey);
        if (!changed && !completesOnboarding) return toProfile(user);
        const now = new Date();
        if (input.realName !== undefined) user.realName = input.realName;
        if (input.nickname !== undefined) user.nickname = input.nickname;
        if (input.profileImageKey !== undefined)
          user.profileImageKey = input.profileImageKey;
        if (completesOnboarding) user.onboardingCompletedAt = now;
        user.updatedAt = now;
        await users.save(user);

        if (completesOnboarding || !wasOnboarding) {
          const eventId = randomUUID();
          const eventType = completesOnboarding
            ? 'USER_CREATED'
            : 'USER_PROFILE_UPDATED';
          await manager.getRepository(OutboxEventEntity).insert({
            eventId,
            aggregateId: user.id,
            eventType,
            payload: {
              eventId,
              type: eventType,
              target: { type: 'USER', id: user.id },
              occurredAt: now.toISOString(),
              version: 1,
              producer: 'user-service',
              correlationId,
              payload: {
                userId: user.id,
                nickname: user.nickname,
                profileImageKey: user.profileImageKey,
              },
            },
            status: 'PENDING',
            publishAttempts: 0,
            createdAt: now,
            publishedAt: null,
          });
        }
        return toProfile(user);
      });
    } catch (error) {
      if (
        error instanceof QueryFailedError &&
        error.driverError?.code === '23505' &&
        error.driverError?.constraint === 'uq_users_nickname_lower'
      ) {
        throw new ConflictException('Nickname is already in use');
      }
      throw error;
    }
  }
}

function toProfile(user: UserEntity): UserProfileResponse {
  return {
    userId: user.id,
    realName: user.realName ?? null,
    nickname: user.nickname,
    profileImageKey: user.profileImageKey,
    status: user.status,
    onboardingRequired: user.onboardingCompletedAt === null,
    createdAt: user.createdAt.toISOString(),
  };
}
