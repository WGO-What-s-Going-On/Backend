import cassandra from 'cassandra-driver';
import { createClient } from 'redis';
import type { Location, LocationStore } from './location.js';

export class CassandraLocationStore implements LocationStore {
  private readonly db: cassandra.Client;
  private readonly cache = createClient({
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

  async put(userId: number, location: Location): Promise<void> {
    // Cassandra가 원본이다. 캐시 실패는 다음 조회에서 원본으로 복구한다.
    await this.db.execute(
      'INSERT INTO user_locations (user_id, latitude, longitude, updated_at) VALUES (?, ?, ?, ?)',
      [
        cassandra.types.Long.fromNumber(userId),
        location.latitude,
        location.longitude,
        location.updatedAt,
      ],
      { prepare: true },
    );
    await this.cache
      .set(`map:location:${userId}`, JSON.stringify(location), { EX: 300 })
      .catch(() => undefined);
  }

  async get(userId: number): Promise<Location | null> {
    const cached = await this.cache
      .get(`map:location:${userId}`)
      .catch(() => null);
    if (cached) {
      const value = JSON.parse(cached) as {
        latitude: number;
        longitude: number;
        updatedAt: string;
      };
      return {
        latitude: value.latitude,
        longitude: value.longitude,
        updatedAt: new Date(value.updatedAt),
      };
    }
    const rows = await this.db.execute(
      'SELECT latitude, longitude, updated_at FROM user_locations WHERE user_id = ?',
      [cassandra.types.Long.fromNumber(userId)],
      { prepare: true },
    );
    const row = rows.first();
    if (!row) return null;
    const location = {
      latitude: row.get('latitude') as number,
      longitude: row.get('longitude') as number,
      updatedAt: row.get('updated_at') as Date,
    };
    // 오래된 위치는 캐시에 되살리지 않는다. 판정 단계에서 5분 경과를 거부한다.
    const remaining = Math.floor(
      (location.updatedAt.getTime() + 300000 - Date.now()) / 1000,
    );
    if (remaining > 0)
      await this.cache
        .set(`map:location:${userId}`, JSON.stringify(location), {
          EX: remaining,
        })
        .catch(() => undefined);
    return location;
  }
}
