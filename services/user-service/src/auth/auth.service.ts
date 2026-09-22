import {
  Injectable,
  ServiceUnavailableException,
  UnauthorizedException,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { randomUUID } from 'node:crypto';
import { DataSource, QueryFailedError } from 'typeorm';

import { OAuthAccountEntity } from '../database/entities/oauth-account.entity.js';
import { UserEntity, UserStatus } from '../database/entities/user.entity.js';
import { AccessTokenService } from './access-token.service.js';
import type { KakaoLoginResponse } from './dto/kakao-login-response.dto.js';
import type { RefreshResponse } from './dto/refresh-response.dto.js';
import { KakaoOAuthClient } from './kakao-oauth.client.js';
import { createRefreshToken, hashRefreshToken, parseRefreshToken, refreshTokenMatchesHash } from './refresh-token.js';
import { RedisSessionStore } from './redis-session.store.js';

const KAKAO_PROVIDER = 'KAKAO';
const MAX_CREATE_ATTEMPTS = 5;

interface LoginUser {
  user: UserEntity;
  isNewUser: boolean;
}

@Injectable()
export class AuthService {
  constructor(
    @InjectDataSource() private readonly dataSource: DataSource,
    private readonly kakaoOAuthClient: KakaoOAuthClient,
    private readonly accessTokenService: AccessTokenService,
    private readonly redisSessionStore: RedisSessionStore,
  ) {}

  async loginWithKakao(authorizationCode: string): Promise<KakaoLoginResponse> {
    const kakaoAccessToken = await this.kakaoOAuthClient.exchangeAuthorizationCode(authorizationCode);
    const providerUserId = await this.kakaoOAuthClient.getUserId(kakaoAccessToken);
    const loginUser = await this.findOrCreateUser(providerUserId);

    if (loginUser.user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Account is not available');
    }

    const sessionId = randomUUID();
    const refreshToken = createRefreshToken(sessionId);
    const accessToken = await this.accessTokenService.create(loginUser.user.id, sessionId);

    try {
      await this.redisSessionStore.save({
        sessionId,
        userId: loginUser.user.id,
        refreshTokenHash: hashRefreshToken(refreshToken),
        createdAt: new Date().toISOString(),
      });
    } catch {
      throw new ServiceUnavailableException('Authentication session is temporarily unavailable');
    }

    return {
      userId: loginUser.user.id,
      isNewUser: loginUser.isNewUser,
      onboardingRequired: loginUser.user.onboardingCompletedAt === null,
      accessToken,
      refreshToken,
      expiresIn: this.accessTokenService.expiresIn,
    };
  }

  private async findOrCreateUser(providerUserId: string): Promise<LoginUser> {
    const existingUser = await this.findUser(providerUserId);
    if (existingUser) {
      return { user: existingUser, isNewUser: false };
    }

    for (let attempt = 0; attempt < MAX_CREATE_ATTEMPTS; attempt += 1) {
      try {
        const user = await this.createUser(providerUserId);
        return { user, isNewUser: true };
      } catch (error) {
        if (!isUniqueViolation(error)) {
          throw error;
        }

        const racedUser = await this.findUser(providerUserId);
        if (racedUser) {
          return { user: racedUser, isNewUser: false };
        }
      }
    }

    throw new ServiceUnavailableException('Unable to create account');
  }

  async refresh(refreshToken: string): Promise<RefreshResponse> {
    const sessionId = parseRefreshToken(refreshToken);
    if (!sessionId) throw new UnauthorizedException('Invalid authentication credentials');

    const session = await this.redisSessionStore.find(sessionId).catch(() => {
      throw new ServiceUnavailableException('Authentication session is temporarily unavailable');
    });
    if (!session || !refreshTokenMatchesHash(refreshToken, session.refreshTokenHash)) {
      throw new UnauthorizedException('Invalid authentication credentials');
    }

    const nextRefreshToken = createRefreshToken(sessionId);
    const accessToken = await this.accessTokenService.create(session.userId, sessionId);
    const rotated = await this.redisSessionStore.rotate(session, hashRefreshToken(nextRefreshToken))
      .catch(() => {
        throw new ServiceUnavailableException('Authentication session is temporarily unavailable');
      });
    if (!rotated) throw new UnauthorizedException('Invalid authentication credentials');

    return { accessToken, refreshToken: nextRefreshToken, expiresIn: this.accessTokenService.expiresIn };
  }

  async logout(userId: string, sessionId: string): Promise<void> {
    const deleted = await this.redisSessionStore.deleteSession(userId, sessionId).catch(() => {
      throw new ServiceUnavailableException('Authentication session is temporarily unavailable');
    });
    if (!deleted) throw new UnauthorizedException('Invalid authentication credentials');
  }

  private async findUser(providerUserId: string): Promise<UserEntity | null> {
    const account = await this.dataSource.getRepository(OAuthAccountEntity).findOne({
      where: { provider: KAKAO_PROVIDER, providerUserId },
      relations: { user: true },
    });
    return account?.user ?? null;
  }

  private createUser(providerUserId: string): Promise<UserEntity> {
    return this.dataSource.transaction(async (manager) => {
      const now = new Date();
      const user = manager.getRepository(UserEntity).create({
        id: randomUUID(),
        nickname: `user_${randomUUID().replaceAll('-', '').slice(0, 24)}`,
        profileImageKey: null,
        status: UserStatus.ACTIVE,
        suspendedUntil: null,
        withdrawalRequestedAt: null,
        withdrawalDeadlineAt: null,
        withdrawnAt: null,
        onboardingCompletedAt: null,
        createdAt: now,
        updatedAt: now,
      });
      await manager.getRepository(UserEntity).save(user);

      const account = manager.getRepository(OAuthAccountEntity).create({
        id: randomUUID(),
        userId: user.id,
        provider: KAKAO_PROVIDER,
        providerUserId,
        providerEmail: null,
        createdAt: now,
        updatedAt: now,
      });
      await manager.getRepository(OAuthAccountEntity).save(account);

      return user;
    });
  }
}

function isUniqueViolation(error: unknown): boolean {
  if (!(error instanceof QueryFailedError)) {
    return false;
  }
  const driverError: unknown = error.driverError;
  return (
    typeof driverError === 'object' &&
    driverError !== null &&
    'code' in driverError &&
    driverError.code === '23505'
  );
}
