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

  async find(sessionId: string): Promise<AuthSession | null> {
    const raw = await this.redis.get(RedisSessionStore.sessionKey(sessionId));
    if (raw === null) return null;
    const session: AuthSession = JSON.parse(raw);
    if (session.sessionId !== sessionId || typeof session.userId !== 'string' ||
        typeof session.refreshTokenHash !== 'string' || typeof session.createdAt !== 'string') {
      throw new Error('Invalid stored authentication session');
    }
    return session;
  }

  async rotate(session: AuthSession, newHash: string): Promise<boolean> {
    // CAS prevents concurrent refreshes and logout races from reviving an old token/session.
    // KEEPTTL preserves the exact expiration deadline rather than resetting the lifetime.
    const result = await this.redis.eval(`
      local raw = redis.call('GET', KEYS[1])
      if not raw or redis.call('TTL', KEYS[1]) <= 0 then return 0 end
      local session = cjson.decode(raw)
      if session.refreshTokenHash ~= ARGV[1] or session.userId ~= ARGV[2] then return 0 end
      session.refreshTokenHash = ARGV[3]
      redis.call('SET', KEYS[1], cjson.encode(session), 'KEEPTTL')
      return 1
    `, 1, RedisSessionStore.sessionKey(session.sessionId),
    session.refreshTokenHash, session.userId, newHash);
    return result === 1;
  }

  async deleteSession(userId: string, sessionId: string): Promise<boolean> {
    const result = await this.redis.eval(`
      local raw = redis.call('GET', KEYS[1])
      if raw and cjson.decode(raw).userId ~= ARGV[1] then return 0 end
      redis.call('SREM', KEYS[2], ARGV[2])
      redis.call('DEL', KEYS[1])
      return 1
    `, 2, RedisSessionStore.sessionKey(sessionId),
    RedisSessionStore.userSessionsKey(userId), userId, sessionId);
    // Redis automatically deletes an empty Set after SREM.
    return result === 1;
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
