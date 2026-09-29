import cassandra from 'cassandra-driver';
import { createClient } from 'redis';
import type { Location, LocationStore } from './location.js';

const latestCacheScript = `
local current = redis.call('GET', KEYS[1])
if current then
  local previous = cjson.decode(current)
  local incoming = cjson.decode(ARGV[1])
  if previous.updatedAtMs and previous.ticks and previous.updateId and
     (previous.updatedAtMs > incoming.updatedAtMs or
      (previous.updatedAtMs == incoming.updatedAtMs and previous.ticks > incoming.ticks) or
      (previous.updatedAtMs == incoming.updatedAtMs and previous.ticks == incoming.ticks and previous.updateId >= incoming.updateId)) then
    return 0
  end
end
redis.call('SET', KEYS[1], ARGV[1], 'EX', ARGV[2])
return 1
`;

export function dayBucket(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export class CassandraLocationStore implements LocationStore {
  readonly db: cassandra.Client;
  readonly cache = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6381',
  });

  constructor() {
    this.db = new cassandra.Client({
      contactPoints: [process.env.CASSANDRA_HOST ?? 'localhost'],
      localDataCenter: process.env.CASSANDRA_DATACENTER ?? 'datacenter1',
      keyspace: process.env.CASSANDRA_KEYSPACE ?? 'wgo_map',
    });
  }

  async connect(): Promise<void> {
    await this.db.connect();
    await this.cache.connect();
  }

  async close(): Promise<void> {
    await this.cache.quit();
    await this.db.shutdown();
  }

  private async cacheLatest(
    userId: number,
    location: Location,
    updateId: cassandra.types.TimeUuid,
    ttl: number,
  ): Promise<void> {
    const { ticks } = updateId.getDatePrecision();
    await this.cache.eval(latestCacheScript, {
      keys: [`map:location:${userId}`],
      arguments: [
        JSON.stringify({
          ...location,
          updatedAtMs: location.updatedAt.getTime(),
          ticks,
          updateId: updateId.toString(),
        }),
        String(ttl),
      ],
    });
  }

  async put(userId: number, location: Location): Promise<Location> {
    // 같은 좌표나 HTTP 재시도도 별도 이력이 되도록 서버가 매번 새 정렬 키를 만든다.
    const updateId = cassandra.types.TimeUuid.now();
    const saved = { ...location, updatedAt: updateId.getDate() };
    await this.db.execute(
      'INSERT INTO user_location_history (user_id, day_bucket, update_id, latitude, longitude, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
      [
        cassandra.types.Long.fromNumber(userId),
        dayBucket(saved.updatedAt),
        updateId,
        saved.latitude,
        saved.longitude,
        saved.updatedAt,
      ],
      { prepare: true },
    );
    // Cassandra 기록이 성공한 뒤에만 캐시를 바꾸고, 역순 완료된 쓰기는 Lua에서 거른다.
    await this.cacheLatest(userId, saved, updateId, 300).catch(() => undefined);
    return saved;
  }

  async get(userId: number): Promise<Location | null> {
    const cached = await this.cache
      .get(`map:location:${userId}`)
      .catch(() => null);
    if (cached) {
      try {
        const value = JSON.parse(cached) as {
          latitude: number;
          longitude: number;
          updatedAt: string;
          updatedAtMs: number;
          ticks: number;
          updateId: string;
        };
        const location = { ...value, updatedAt: new Date(value.updatedAt) };
        if (
          Number.isFinite(location.latitude) &&
          Number.isFinite(location.longitude) &&
          Number.isFinite(location.updatedAt.getTime()) &&
          location.updatedAt.getTime() === value.updatedAtMs &&
          Number.isInteger(value.ticks) &&
          typeof value.updateId === 'string'
        )
          return location;
      } catch {
        // 손상된 캐시는 원본 조회로 복구한다.
      }
    }
    const now = new Date();
    const user = cassandra.types.Long.fromNumber(userId);
    for (const day of [now, new Date(now.getTime() - 86400000)]) {
      const rows = await this.db.execute(
        'SELECT update_id, latitude, longitude, updated_at FROM user_location_history WHERE user_id = ? AND day_bucket = ? LIMIT 1',
        [user, dayBucket(day)],
        { prepare: true },
      );
      const row = rows.first();
      if (row) {
        const location = {
          latitude: row.get('latitude') as number,
          longitude: row.get('longitude') as number,
          updatedAt: row.get('updated_at') as Date,
        };
        const remaining = Math.floor(
          (location.updatedAt.getTime() + 300000 - Date.now()) / 1000,
        );
        if (remaining > 0)
          await this.cacheLatest(
            userId,
            location,
            row.get('update_id') as cassandra.types.TimeUuid,
            remaining,
          ).catch(() => undefined);
        return location;
      }
      // 오늘 기록이 없을 때만 자정 직전의 유효한 기록이 전날 버킷에 있을 수 있다.
    }
    return null;
  }
}
