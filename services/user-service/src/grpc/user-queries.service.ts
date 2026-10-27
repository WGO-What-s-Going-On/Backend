import { Injectable } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { status } from '@grpc/grpc-js';
import { DataSource, In } from 'typeorm';
import { UserEntity, UserStatus } from '../database/entities/user.entity.js';
import { parseUserId } from '../user-id.js';

export class UserRpcError extends Error {
  constructor(
    readonly code: status,
    message: string,
  ) {
    super(message);
  }
}

@Injectable()
export class UserQueriesService {
  constructor(@InjectDataSource() private readonly database: DataSource) {}

  async getUserProfile(input: { userId?: unknown }) {
    const id = requireId(input.userId);
    const user = await this.database
      .getRepository(UserEntity)
      .findOneBy({ id });
    if (!user || user.status === UserStatus.WITHDRAWN)
      throw new UserRpcError(status.NOT_FOUND, 'Profile not found');
    if (!user.onboardingCompletedAt)
      throw new UserRpcError(
        status.FAILED_PRECONDITION,
        'Profile onboarding incomplete',
      );
    return profile(user);
  }

  async batchGetUserProfiles(input: { userIds?: unknown }) {
    const values = input.userIds ?? [];
    if (!Array.isArray(values) || values.length === 0 || values.length > 100) {
      throw new UserRpcError(
        status.INVALID_ARGUMENT,
        'user_ids must contain between 1 and 100 IDs',
      );
    }
    const ids = [...new Set(values.map(requireId))];
    const users = await this.database
      .getRepository(UserEntity)
      .findBy({ id: In(ids) });
    const available = new Map(
      users
        .filter(
          (user) =>
            user.onboardingCompletedAt && user.status !== UserStatus.WITHDRAWN,
        )
        .map((user) => [user.id, user]),
    );
    return {
      profiles: ids
        .filter((id) => available.has(id))
        .map((id) => profile(available.get(id)!)),
      unavailableUserIds: ids.filter((id) => !available.has(id)),
    };
  }

  async getUserStatus(input: { userId?: unknown }) {
    const id = requireId(input.userId);
    const user = await this.database
      .getRepository(UserEntity)
      .findOneBy({ id });
    if (!user) throw new UserRpcError(status.NOT_FOUND, 'User not found');
    return {
      userId: user.id,
      status: grpcStatus(user.status),
      ...(user.suspendedUntil
        ? { suspendedUntil: timestamp(user.suspendedUntil) }
        : {}),
    };
  }
}

function requireId(value: unknown): string {
  const userId = parseUserId(value);
  if (!userId)
    throw new UserRpcError(status.INVALID_ARGUMENT, 'Invalid user ID');
  return userId;
}

function profile(user: UserEntity) {
  return {
    userId: user.id,
    nickname: user.nickname,
    status: grpcStatus(user.status),
    ...(user.profileImageKey === null
      ? {}
      : { profileImageKey: user.profileImageKey }),
  };
}

function grpcStatus(value: UserStatus): number {
  switch (value) {
    case UserStatus.ACTIVE:
      return 1;
    case UserStatus.SUSPENDED:
      return 2;
    case UserStatus.WITHDRAWAL_PENDING:
      return 3;
    case UserStatus.WITHDRAWN:
      return 4;
    default:
      throw new Error('Unsupported user status');
  }
}

function timestamp(value: Date): { seconds: string; nanos: number } {
  const milliseconds = value.getTime();
  return {
    seconds: String(Math.floor(milliseconds / 1000)),
    nanos: (milliseconds % 1000) * 1_000_000,
  };
}
