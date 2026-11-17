import { createClient } from 'redis';
import { beforeEach, afterEach, describe, expect, it } from 'vitest';
import {
  LocationGeoIndex,
  locationGeoKeys,
} from '../src/location-geo-index.js';
import { notificationLocationSaved } from '../src/notification-location-events.js';
import type { Location, LocationStore } from '../src/location.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite(
  'incremental location GEO, without subscriptions or Cassandra scans',
  () => {
    const redis = createClient({
      url: 'redis://127.0.0.1:6381/13',
      socket: { reconnectStrategy: false },
    });
    const positions = new Map<number, Location>(),
      moving = new Set<number>();
    let now: number, index: LocationGeoIndex;
    const store: LocationStore = {
      put: async (id, value) => {
        positions.set(id, value);
        return value;
      },
      get: async (id) => positions.get(id) ?? null,
      movement: async (id) => {
        const location = positions.get(id);
        return location
          ? {
              location,
              stop: location,
              reason: moving.has(id) ? 'USER_MOVING' : '',
            }
          : null;
      },
    };
    async function at(id: number, metres = 0, age = 0) {
      positions.set(id, {
        latitude: 37.5 + ((metres / 6371008.8) * 180) / Math.PI,
        longitude: 127,
        updatedAt: new Date(now - age),
      });
      notificationLocationSaved(id);
      await index.flush();
    }
    const find = (radius = 150) =>
      index.find({
        latitude: 37.5,
        longitude: 127,
        participationRadiusM: radius,
        authorId: '1',
        limit: 50,
      });
    beforeEach(async () => {
      now = Date.now();
      positions.clear();
      moving.clear();
      await redis.connect();
      if (await redis.dbSize()) throw new Error('Test DB13 must be empty');
      index = new LocationGeoIndex(redis, store, () => now);
      index.start();
      await index.flush();
      now += 300001;
    });
    afterEach(async () => {
      await index.close();
      await redis.del(locationGeoKeys);
      await redis.quit();
    });
    it.each([150, 250, 350])(
      'checks exact %im boundaries using authoritative positions',
      async (radius) => {
        await at(1);
        await at(2, radius - 0.000001);
        await at(3, radius + 0.000001);
        expect((await find(radius)).users).toEqual([{ userId: '2' }]);
      },
    );
    it('updates a user location, excludes moving/stale users and cleans expired members', async () => {
      await at(2, 200);
      expect((await find()).users).toEqual([]);
      await at(2, 10);
      expect((await find()).users).toEqual([{ userId: '2' }]);
      moving.add(2);
      expect((await find()).users).toEqual([]);
      moving.clear();
      now += 300001;
      expect((await find()).users).toEqual([]);
      expect(await redis.zCard(locationGeoKeys[0]!)).toBe(0);
    });
    it('distinguishes index loss/warm-up from a ready empty result and recovers on new updates', async () => {
      await at(2);
      await redis.del(locationGeoKeys[0]!);
      await expect(find()).rejects.toThrow('warming');
      await at(2);
      await expect(find()).rejects.toThrow('warming');
      now += 300001;
      await at(2);
      expect((await find()).users).toEqual([{ userId: '2' }]);
      await index.close();
      index = new LocationGeoIndex(redis, store, () => now);
      index.start();
      expect((await find()).users).toEqual([{ userId: '2' }]);
    });
    it('rejects Redis outages and allows original location observers to fail independently', async () => {
      await redis.disconnect();
      expect(() => notificationLocationSaved(2)).not.toThrow();
      await expect(find()).rejects.toThrow();
      await redis.connect();
    });
    it('bounds queue overflow and restarts the warm-up instead of serving incomplete success', async () => {
      for (let id = 1; id <= 1002; id++) notificationLocationSaved(id);
      await expect(find()).rejects.toThrow('warming');
    });
    it('caps GEO membership, fails closed at capacity and sets finite key TTLs', async () => {
      const entries = Array.from({ length: 100000 }, (_, i) => ({
        value: String(i + 1),
        score: now,
      }));
      await redis
        .multi()
        .zAdd(
          locationGeoKeys[0]!,
          entries.map((e) => ({ ...e, score: 0 })),
        )
        .zAdd(locationGeoKeys[1]!, entries)
        .hSet(locationGeoKeys[2]!, 'count', '100000')
        .exec();
      await at(100001);
      expect(await redis.zCard(locationGeoKeys[0]!)).toBe(100000);
      await expect(find()).rejects.toThrow('warming');
      for (const key of locationGeoKeys)
        expect(await redis.pTTL(key)).toBeGreaterThan(0);
    });
  },
);
