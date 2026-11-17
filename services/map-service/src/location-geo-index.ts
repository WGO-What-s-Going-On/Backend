import { randomUUID } from 'node:crypto';
import type { createClient } from 'redis';
import { decide, validCoordinates, type LocationStore } from './location.js';
import { onNotificationLocationSaved } from './notification-location-events.js';
import { RecipientIndexUnavailable } from './notification-recipient-index.js';

// These keys contain only the new, disposable notification projection.
export const locationGeoKeys = [
  'map:nearby-location:v1:geo',
  'map:nearby-location:v1:time',
  'map:nearby-location:v1:state',
];
const maxAge = 300000;
const capacity = 100000;
const maintain = `
local count=tonumber(redis.call('HGET',KEYS[3],'count') or '-1')
if count<0 or count~=redis.call('ZCARD',KEYS[1]) or count~=redis.call('ZCARD',KEYS[2]) then
 redis.call('DEL',unpack(KEYS))
 redis.call('HSET',KEYS[3],'born',ARGV[1],'epoch',ARGV[2],'count',0)
end
local stale=redis.call('ZRANGEBYSCORE',KEYS[2],'-inf','('..(tonumber(ARGV[1])-300000),'LIMIT',0,1000)
for _,id in ipairs(stale) do redis.call('ZREM',KEYS[1],id);redis.call('ZREM',KEYS[2],id) end
if ARGV[3]~='' then
 if ARGV[4]=='' then redis.call('ZREM',KEYS[1],ARGV[3]);redis.call('ZREM',KEYS[2],ARGV[3])
 elseif redis.call('ZSCORE',KEYS[2],ARGV[3]) or redis.call('ZCARD',KEYS[2])<100000 then
  redis.call('GEOADD',KEYS[1],ARGV[5],ARGV[4],ARGV[3]);redis.call('ZADD',KEYS[2],ARGV[6],ARGV[3])
 else redis.call('HSET',KEYS[3],'faultUntil',tonumber(ARGV[1])+300000) end
end
redis.call('HSET',KEYS[3],'count',redis.call('ZCARD',KEYS[2]))
for _,key in ipairs(KEYS) do redis.call('PEXPIRE',key,610000) end
return redis.call('HGETALL',KEYS[3])`;

export class LocationGeoIndex {
  private dirty = new Set<number>();
  private overflow = false;
  private failed = false;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private running?: Promise<void>;
  constructor(
    readonly redis: ReturnType<typeof createClient>,
    private readonly store: LocationStore,
    private readonly clock = Date.now,
  ) {}
  start() {
    this.unsubscribe = onNotificationLocationSaved((id) => {
      if (this.dirty.size >= 1000) this.overflow = true;
      else this.dirty.add(id);
    });
    this.timer = setInterval(() => {
      void this.flush().catch(() => undefined);
    }, 100);
    this.timer.unref();
  }
  async close() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }
  private async state(
    userId = '',
    location?: { latitude: number; longitude: number; updatedAt: Date },
  ) {
    // Redis GEO supports latitude +/-85.05112878. Other valid Map positions remain
    // untouched; notification discovery fails closed for unsupported centers.
    const usable =
      location &&
      validCoordinates(location.latitude, location.longitude) &&
      Math.abs(location.latitude) <= 85.05112878 &&
      decide(location, location, 1, new Date(this.clock())).allowed;
    const flat = (await this.redis.eval(maintain, {
      keys: locationGeoKeys,
      arguments: [
        String(this.clock()),
        randomUUID(),
        userId,
        usable ? String(location.latitude) : '',
        usable ? String(location.longitude) : '',
        usable ? String(location.updatedAt.getTime()) : '',
      ],
    })) as string[];
    return Object.fromEntries(
      Array.from({ length: flat.length / 2 }, (_, i) => [
        flat[i * 2]!,
        flat[i * 2 + 1]!,
      ]),
    );
  }
  async flush() {
    if (this.running) return this.running;
    this.running = this.refresh()
      .catch(async (error) => {
        // A dropped update requires another warm-up, rather than an empty success.
        this.failed = true;
        await this.redis.del(locationGeoKeys).catch(() => undefined);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async refresh() {
    if (this.overflow || this.failed) {
      this.overflow = false;
      this.failed = false;
      this.dirty.clear();
      await this.redis.del(locationGeoKeys);
    }
    const ids = [...this.dirty];
    this.dirty.clear();
    for (let offset = 0; offset < ids.length; offset += 5)
      await Promise.all(
        ids.slice(offset, offset + 5).map(async (id) => {
          const movement = await this.store.movement(id);
          const location = movement?.location ?? (await this.store.get(id));
          await this.state(String(id), location ?? undefined);
        }),
      );
    await this.state();
  }
  async find(
    input: {
      latitude: number;
      longitude: number;
      participationRadiusM: number;
      authorId: string;
      limit: number;
      afterUserId?: string;
    },
    check = () => {},
  ) {
    if (Math.abs(input.latitude) > 85.05112878)
      throw new RecipientIndexUnavailable('GEO coverage unavailable');
    await this.flush();
    check();
    const state = await this.state();
    if (
      this.clock() - Number(state.born) < maxAge ||
      Number(state.faultUntil ?? 0) > this.clock()
    )
      throw new RecipientIndexUnavailable('Location index warming up');
    // Global cardinality is capped. A page performs at most 50 authoritative reads.
    const members = await this.redis.geoSearch(
      locationGeoKeys[0]!,
      { longitude: input.longitude, latitude: input.latitude },
      { radius: input.participationRadiusM + 1, unit: 'm' },
    );
    if (members.length > capacity)
      throw new RecipientIndexUnavailable('Location index capacity exceeded');
    const ordered = members
      .filter((id) => id !== input.authorId && id > (input.afterUserId ?? ''))
      .sort();
    const page = ordered.slice(0, input.limit),
      users: Array<{ userId: string }> = [];
    for (let offset = 0; offset < page.length; offset += 5) {
      check();
      const group = await Promise.all(
        page.slice(offset, offset + 5).map(async (userId) => {
          const movement = await this.store.movement(Number(userId));
          const location =
            movement?.location ?? (await this.store.get(Number(userId)));
          return {
            userId,
            allowed:
              !movement?.reason &&
              !!location &&
              validCoordinates(location.latitude, location.longitude) &&
              decide(
                location,
                input,
                input.participationRadiusM,
                new Date(this.clock()),
              ).allowed,
          };
        }),
      );
      for (const candidate of group)
        if (candidate.allowed) users.push({ userId: candidate.userId });
    }
    check();
    const current = await this.state();
    if (
      current.epoch !== state.epoch ||
      Number(current.faultUntil ?? 0) > this.clock()
    )
      throw new RecipientIndexUnavailable('Location index reset');
    return {
      users,
      nextAfterUserId: ordered.length > page.length ? page.at(-1)! : '',
    };
  }
}
