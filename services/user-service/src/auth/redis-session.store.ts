import { Injectable, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Redis } from 'ioredis';

export interface AuthSession {
  sessionId: string;
  userId: string;
  refreshTokenHash: string;
  createdAt: string;
}

@Injectable()
export class RedisSessionStore implements OnModuleDestroy {
  private readonly redis: Redis;
  private readonly refreshTtlSeconds: number;

  constructor(config: ConfigService) {
    const redisUrl = requiredConfig(config, 'redis.url');
    this.refreshTtlSeconds = positiveIntegerConfig(config, 'auth.refreshTtlSeconds');
    this.redis = new Redis(redisUrl, { maxRetriesPerRequest: 1 });
    this.redis.on('error', () => undefined);
  }

  async save(session: AuthSession): Promise<void> {
    const sessionKey = RedisSessionStore.sessionKey(session.sessionId);
    const userSessionsKey = RedisSessionStore.userSessionsKey(session.userId);
    const results = await this.redis
      .multi()
      .set(sessionKey, JSON.stringify(session), 'EX', this.refreshTtlSeconds)
      .sadd(userSessionsKey, session.sessionId)
      .expire(userSessionsKey, this.refreshTtlSeconds)
      .exec();

    if (!results || results.some(([error]) => error !== null)) {
      throw new Error('Failed to save authentication session');
    }
  }

  async onModuleDestroy(): Promise<void> {
    if (this.redis.status === 'end') {
      return;
    }
    await this.redis.quit().catch(() => this.redis.disconnect());
  }

  static sessionKey(sessionId: string): string {
    return `auth:session:${sessionId}`;
  }

  static userSessionsKey(userId: string): string {
    return `auth:user-sessions:${userId}`;
  }
}

function requiredConfig(config: ConfigService, key: string): string {
  const value = config.get<string>(key);
  if (!value?.trim()) {
    throw new Error(`${key} is required`);
  }
  return value;
}

function positiveIntegerConfig(config: ConfigService, key: string): number {
  const value = Number(requiredConfig(config, key));
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${key} must be a positive integer`);
  }
  return value;
}
