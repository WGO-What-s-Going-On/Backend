import { randomUUID } from 'node:crypto';
import { gridDisk, latLngToCell } from 'h3-js';
import type { createClient } from 'redis';
import { decide, validCoordinates, type LocationStore } from './location.js';
import { onNotificationLocationSaved } from './notification-location-events.js';

const prefix = 'map:notification-recipients:v1:';
const activeKey = `${prefix}active`;
const lifetimeMs = 30_000;
const maxRecipients = 10_000;
export type Consent = { userId: string; revision: string; expiresAtMs: string };
type IndexedConsent = Consent & { cell: string; locationExpiresAtMs: number };
export class RecipientIndexUnavailable extends Error {}

// Membership and its cell manifest change atomically, including moves between cells.
const put = `
if redis.call('EXISTS',KEYS[1]) == 0 then return 0 end
local value=cjson.decode(ARGV[2])
local old=redis.call('HGET',KEYS[1],'user:'..ARGV[1])
if old then
  local cell=cjson.decode(old).cell
  if cell~='' then
    local cellKey=KEYS[1]..':cell:'..cell
    redis.call('SREM',cellKey,ARGV[1])
    redis.call('HSET',KEYS[1],'count:'..cell,tostring(redis.call('SCARD',cellKey)))
  end
end
redis.call('HSET',KEYS[1],'user:'..ARGV[1],ARGV[2])
if value.cell~='' then
  local cellKey=KEYS[1]..':cell:'..value.cell
  redis.call('SADD',cellKey,ARGV[1])
  redis.call('PEXPIRE',cellKey,redis.call('PTTL',KEYS[1]))
  redis.call('HSET',KEYS[1],'count:'..value.cell,tostring(redis.call('SCARD',cellKey)))
end
return 1`;

export class NotificationRecipientIndex {
  private dirty = new Set<number>();
  private overflow = false;
  private running?: Promise<void>;
  private timer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  constructor(
    readonly redis: ReturnType<typeof createClient>,
    private readonly store: LocationStore,
  ) {}

  start() {
    this.unsubscribe = onNotificationLocationSaved((id) => {
      if (this.dirty.size >= 1000) this.overflow = true;
      else this.dirty.add(id);
    });
    this.timer = setInterval(() => {
      void this.refresh().catch(() => undefined);
    }, 100);
    this.timer.unref();
  }
  async close() {
    this.unsubscribe?.();
    if (this.timer) clearInterval(this.timer);
    await this.running?.catch(() => undefined);
  }
  private refresh() {
    if (this.running) return this.running;
    this.running = this.refreshDirty()
      .catch(async (error) => {
        // Never answer an empty success after a failed index update.
        await this.redis.del(activeKey).catch(() => undefined);
        throw error;
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private key(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error('Invalid snapshot');
    return `${prefix}snapshot:${id}`;
  }
  async begin(expectedCount: number) {
    if (
      !Number.isInteger(expectedCount) ||
      expectedCount < 0 ||
      expectedCount > maxRecipients
    )
      throw new Error('Invalid recipient count');
    const id = randomUUID();
    await this.redis
      .multi()
      .hSet(this.key(id), {
        state: 'building',
        expected: String(expectedCount),
      })
      .pExpire(this.key(id), lifetimeMs)
      .exec();
    return id;
  }
  private async record(consent: Consent): Promise<IndexedConsent> {
    const now = Date.now();
    const id = Number(consent.userId);
    const expiry = Number(consent.expiresAtMs);
    if (
      !Number.isSafeInteger(id) ||
      id <= 0 ||
      !consent.revision ||
      consent.revision.length > 100 ||
      !Number.isSafeInteger(expiry) ||
      expiry > now + 900_000 + 30_000
    )
      throw new Error('Invalid consent');
    if (expiry <= now) return { ...consent, cell: '', locationExpiresAtMs: 0 };
    const movement = await this.store.movement(id);
    const location = movement?.location ?? (await this.store.get(id));
    const eligible =
      expiry > now &&
      location &&
      validCoordinates(location.latitude, location.longitude) &&
      location.updatedAt instanceof Date &&
      Number.isFinite(location.updatedAt.getTime()) &&
      decide(location, location, 150).allowed &&
      !movement?.reason;
    return {
      ...consent,
      cell: eligible
        ? latLngToCell(location.latitude, location.longitude, 8)
        : '',
      locationExpiresAtMs: location
        ? location.updatedAt.getTime() + 300_000
        : 0,
    };
  }
  async add(id: string, recipients: Consent[]) {
    if (
      recipients.length < 1 ||
      recipients.length > 50 ||
      (await this.redis.hGet(this.key(id), 'state')) !== 'building'
    )
      throw new RecipientIndexUnavailable('Snapshot expired or invalid batch');
    for (let offset = 0; offset < recipients.length; offset += 5) {
      const records = await Promise.all(
        recipients.slice(offset, offset + 5).map((c) => this.record(c)),
      );
      for (const record of records) await this.write(id, record);
    }
  }
  private async write(id: string, record: IndexedConsent) {
    if (
      (await this.redis.eval(put, {
        keys: [this.key(id)],
        arguments: [record.userId, JSON.stringify(record)],
      })) !== 1
    )
      throw new RecipientIndexUnavailable('Snapshot expired');
  }
  async publish(id: string) {
    const key = this.key(id);
    const all = await this.redis.hGetAll(key);
    const count = Object.keys(all).filter((k) => k.startsWith('user:')).length;
    if (all.state !== 'building' || count !== Number(all.expected))
      throw new RecipientIndexUnavailable('Incomplete snapshot');
    // Publication does not extend the lifetime of any captured location or consent.
    const ttl = await this.redis.pTTL(key);
    if (ttl < 1000) throw new RecipientIndexUnavailable('Snapshot expired');
    await this.redis
      .multi()
      .hSet(key, 'state', 'ready')
      .set(activeKey, id, { PX: ttl })
      .exec();
  }
  async refreshDirty() {
    if (!this.dirty.size && !this.overflow) return;
    const ids = [...this.dirty];
    this.dirty.clear();
    if (this.overflow) {
      this.overflow = false;
      await this.redis.del(activeKey);
      return;
    }
    const active = await this.redis.get(activeKey);
    if (!active) return;
    for (let offset = 0; offset < ids.length; offset += 5) {
      await Promise.all(
        ids.slice(offset, offset + 5).map(async (id) => {
          const raw = await this.redis.hGet(this.key(active), `user:${id}`);
          if (raw) await this.write(active, await this.record(JSON.parse(raw)));
        }),
      );
    }
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
    // Complete locally queued moves before candidate discovery, without delaying location writes.
    await this.refresh();
    check();
    const active = await this.redis.get(activeKey);
    if (!active)
      throw new RecipientIndexUnavailable(
        'Recipient index requires reconciliation',
      );
    const key = this.key(active);
    if ((await this.redis.hGet(key, 'state')) !== 'ready')
      throw new RecipientIndexUnavailable('Recipient index unavailable');
    const ids = new Set<string>();
    // Resolution 8 and two rings conservatively cover 150m, including poles/date line.
    for (const cell of gridDisk(
      latLngToCell(input.latitude, input.longitude, 8),
      2,
    )) {
      check();
      const expected = await this.redis.hGet(key, `count:${cell}`);
      const members = await this.redis.sMembers(`${key}:cell:${cell}`);
      if (expected === null && !members.length) continue;
      if (expected === null)
        throw new RecipientIndexUnavailable('Recipient cell manifest missing');
      if (members.length !== Number(expected))
        throw new RecipientIndexUnavailable('Recipient cell corrupt');
      for (const id of members)
        if (id !== input.authorId && id > (input.afterUserId ?? ''))
          ids.add(id);
    }
    const ordered = [...ids].sort();
    // Bound work even when a dense H3 cell contains many users outside the exact radius.
    // Empty filtered pages still carry a cursor so the durable worker makes progress.
    const candidates = ordered.slice(0, input.limit);
    const users: Array<{ userId: string; revision: string }> = [];
    let last = '';
    for (let offset = 0; offset < candidates.length; offset += 5) {
      check();
      const group = await Promise.all(
        candidates.slice(offset, offset + 5).map(async (id) => {
          const raw = await this.redis.hGet(key, `user:${id}`);
          if (!raw)
            throw new RecipientIndexUnavailable('Recipient record missing');
          const consent = JSON.parse(raw) as IndexedConsent;
          if (Number(consent.expiresAtMs) <= Date.now())
            return { userId: id, revision: consent.revision, allowed: false };
          const movement = await this.store.movement(Number(id));
          const location =
            movement?.location ?? (await this.store.get(Number(id)));
          return {
            userId: id,
            revision: consent.revision,
            allowed:
              Number(consent.expiresAtMs) > Date.now() &&
              !!location &&
              validCoordinates(location.latitude, location.longitude) &&
              location.updatedAt instanceof Date &&
              Number.isFinite(location.updatedAt.getTime()) &&
              !movement?.reason &&
              decide(location, input, Math.min(150, input.participationRadiusM))
                .allowed,
          };
        }),
      );
      for (const candidate of group) {
        if (users.length === input.limit) break;
        last = candidate.userId;
        if (candidate.allowed)
          users.push({
            userId: candidate.userId,
            revision: candidate.revision,
          });
      }
    }
    check();
    if (
      (await this.redis.get(activeKey)) !== active ||
      (await this.redis.hGet(key, 'state')) !== 'ready'
    )
      throw new RecipientIndexUnavailable('Recipient index changed; retry');
    return {
      users,
      nextAfterUserId: ordered.some((id) => id > last) ? last : '',
    };
  }
}
