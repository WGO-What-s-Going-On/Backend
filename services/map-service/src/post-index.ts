import { createHash, randomUUID } from 'node:crypto';
import cassandra from 'cassandra-driver';
import { gridDisk, latLngToCell } from 'h3-js';
import { createClient } from 'redis';
import { distanceM, validCoordinates } from './location.js';

export const POST_STREAM = 'post:events';
export const POST_GROUP = 'post-map';
export const DEAD_STREAM = 'map:post:dead';
const ACTIVE_KEY = 'map:posts:geo:active';
const REBUILD_KEY = 'map:posts:geo:rebuild';
const DEFAULT_GEO = 'map:posts:geo:v1';
const GEO_LATITUDE_LIMIT = 85.05112878;
const POST_ID =
  /^post_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const EVENT_ID =
  /^evt_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export type PostCreated = {
  eventId: string;
  postId: string;
  authorId: number;
  latitude: number;
  longitude: number;
  radiusM: number;
  category: string;
  expiresAt: Date | null;
  cell: string;
  shard: number;
};
export type PostStatus = 'ACTIVE' | 'EXPIRED' | 'DELETED';
export type PostStatusEvent = {
  postId: string;
  status: 'EXPIRED' | 'DELETED';
  occurredAt: Date;
};
export type NearbyQuery = {
  latitude: number;
  longitude: number;
  radiusM: 150 | 250 | 350;
  limit: number;
  cursor?: string;
};
export type NearbyResult = {
  items: Array<{ postId: string; distanceM: number }>;
  nextCursor: string | null;
};

export function parsePostStatus(
  raw: string | undefined,
  fields: Record<string, string>,
): PostStatusEvent {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '');
  } catch {
    throw new Error('Invalid data JSON');
  }
  if (
    !object(value) ||
    !['PostExpired', 'PostDeleted'].includes(String(value.eventType)) ||
    value.eventType !== fields.eventType ||
    value.schemaVersion !== 1 ||
    value.producer !== 'post-service' ||
    typeof value.eventId !== 'string' ||
    !EVENT_ID.test(value.eventId) ||
    value.eventId !== fields.eventId ||
    typeof value.aggregateId !== 'string' ||
    !POST_ID.test(value.aggregateId) ||
    typeof value.occurredAt !== 'string' ||
    !Number.isFinite(Date.parse(value.occurredAt))
  )
    throw new Error('Invalid post status event');
  return {
    postId: value.aggregateId,
    status: value.eventType === 'PostDeleted' ? 'DELETED' : 'EXPIRED',
    occurredAt: new Date(value.occurredAt),
  };
}

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parsePostCreated(
  raw: string | undefined,
  fields: Record<string, string>,
): PostCreated {
  let value: unknown;
  try {
    value = JSON.parse(raw ?? '');
  } catch {
    throw new Error('Invalid data JSON');
  }
  if (!object(value) || !object(value.post))
    throw new Error('Invalid PostCreated envelope');
  const post = value.post;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const id = new RegExp(`^post_${uuid}$`);
  const eventId = new RegExp(`^evt_${uuid}$`);
  if (
    value.eventType !== 'PostCreated' ||
    fields.eventType !== 'PostCreated' ||
    value.schemaVersion !== 1 ||
    value.producer !== 'post-service' ||
    typeof value.eventId !== 'string' ||
    !eventId.test(value.eventId) ||
    value.eventId !== fields.eventId ||
    typeof value.aggregateId !== 'string' ||
    !id.test(value.aggregateId) ||
    post.postId !== value.aggregateId ||
    typeof post.postId !== 'string' ||
    !id.test(post.postId) ||
    !Number.isSafeInteger(post.authorId) ||
    (post.authorId as number) <= 0 ||
    typeof post.latitude !== 'number' ||
    typeof post.longitude !== 'number' ||
    !validCoordinates(post.latitude, post.longitude) ||
    !Number.isInteger(post.radiusM) ||
    (post.radiusM as number) < 1 ||
    (post.radiusM as number) > 10000 ||
    typeof post.category !== 'string' ||
    !/^[A-Z][A-Z_]*$/.test(post.category) ||
    post.category.length > 40 ||
    !(
      post.expiresAt === null ||
      (typeof post.expiresAt === 'string' &&
        Number.isFinite(Date.parse(post.expiresAt)))
    )
  )
    throw new Error('Invalid PostCreated fields');
  const postId = post.postId as string;
  return {
    eventId: value.eventId,
    postId,
    authorId: post.authorId as number,
    latitude: post.latitude,
    longitude: post.longitude,
    radiusM: post.radiusM as number,
    category: post.category,
    expiresAt:
      post.expiresAt === null ? null : new Date(post.expiresAt as string),
    cell: latLngToCell(post.latitude, post.longitude, 8),
    shard: createHash('sha256').update(postId).digest()[0]! % 16,
  };
}

export class PostIndex {
  readonly db = new cassandra.Client({
    contactPoints: [process.env.CASSANDRA_HOST ?? 'localhost'],
    localDataCenter: process.env.CASSANDRA_DATACENTER ?? 'datacenter1',
    keyspace: process.env.CASSANDRA_KEYSPACE ?? 'wgo_map',
  });
  readonly redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6381',
  });

  async connect(): Promise<void> {
    await this.db.connect();
    await this.redis.connect();
  }
  async close(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
    await this.db.shutdown();
  }

  async write(post: PostCreated): Promise<void> {
    // 생성 이벤트가 늦게 도착해도 이미 기록한 만료·삭제 상태를 되살리지 않는다.
    await this.db.execute(
      'INSERT INTO post_status (post_id, status) VALUES (?, ?) IF NOT EXISTS',
      [post.postId, 'ACTIVE'],
      { prepare: true },
    );
    // 원본을 먼저 저장한다. 중간에 실패하면 같은 이벤트를 다시 처리해 빠진 인덱스를 채운다.
    await this.db.execute(
      'INSERT INTO post_locations (post_id, event_id, author_id, latitude, longitude, radius_m, category, expires_at, cell, shard) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [
        post.postId,
        post.eventId,
        cassandra.types.Long.fromNumber(post.authorId),
        post.latitude,
        post.longitude,
        post.radiusM,
        post.category,
        post.expiresAt,
        post.cell,
        post.shard,
      ],
      { prepare: true },
    );
    await this.writeCell(post);
    if (
      (await this.getStatus(post.postId)) === 'ACTIVE' &&
      (!post.expiresAt || post.expiresAt.getTime() > Date.now())
    )
      await this.writeGeo(post);
  }

  async getStatus(postId: string): Promise<PostStatus | null> {
    const row = (
      await this.db.execute(
        'SELECT status FROM post_status WHERE post_id = ?',
        [postId],
        { prepare: true },
      )
    ).first();
    return row ? (row.get('status') as PostStatus) : null;
  }

  async transition(event: PostStatusEvent): Promise<void> {
    // 상태 행이 아직 없어도 비활성 상태를 먼저 기록해 늦은 PostCreated를 막는다.
    await this.db.execute(
      'INSERT INTO post_status (post_id, status, occurred_at) VALUES (?, ?, ?) IF NOT EXISTS',
      [event.postId, event.status, event.occurredAt],
      { prepare: true },
    );
    const from =
      event.status === 'DELETED' ? ['ACTIVE', 'EXPIRED'] : ['ACTIVE'];
    for (const status of from)
      await this.db.execute(
        'UPDATE post_status SET status = ?, occurred_at = ? WHERE post_id = ? IF status = ?',
        [event.status, event.occurredAt, event.postId, status],
        { prepare: true },
      );
    // ACK 전에 현재 키와 재구축 키 모두에서 제거한다. 실패 시 Pending에서 재시도한다.
    await this.redis.eval(
      `local active = redis.call('GET', KEYS[1]) or ARGV[1]
       redis.call('ZREM', active, ARGV[2])
       local staging = redis.call('GET', KEYS[2])
       if staging and staging ~= active then redis.call('ZREM', staging, ARGV[2]) end
       return 1`,
      {
        keys: [ACTIVE_KEY, REBUILD_KEY],
        arguments: [DEFAULT_GEO, event.postId],
      },
    );
  }

  async writeCell(post: PostCreated): Promise<void> {
    await this.db.execute(
      'INSERT INTO posts_by_cell (cell, shard, post_id, latitude, longitude, radius_m, category, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [
        post.cell,
        post.shard,
        post.postId,
        post.latitude,
        post.longitude,
        post.radiusM,
        post.category,
        post.expiresAt,
      ],
      { prepare: true },
    );
  }

  async writeGeo(post: PostCreated): Promise<void> {
    if (Math.abs(post.latitude) > GEO_LATITUDE_LIMIT) return;
    // 단일 Redis 명령에서 현재 GEO와 재구축 키에 함께 쓴다. 전환과 경합해도 새 게시물이 빠지지 않는다.
    await this.redis.eval(
      `local active = redis.call('GET', KEYS[1]) or ARGV[1]
       redis.call('GEOADD', active, ARGV[2], ARGV[3], ARGV[4])
       local staging = redis.call('GET', KEYS[2])
       if staging and staging ~= active then redis.call('GEOADD', staging, ARGV[2], ARGV[3], ARGV[4]) end
       return 1`,
      {
        keys: [ACTIVE_KEY, REBUILD_KEY],
        arguments: [
          DEFAULT_GEO,
          String(post.longitude),
          String(post.latitude),
          post.postId,
        ],
      },
    );
  }

  async nearby(query: NearbyQuery): Promise<NearbyResult> {
    const center = { latitude: query.latitude, longitude: query.longitude };
    let candidates: string[] = [];
    if (Math.abs(query.latitude) <= GEO_LATITUDE_LIMIT) {
      try {
        const key = (await this.redis.get(ACTIVE_KEY)) ?? DEFAULT_GEO;
        candidates = (await this.redis.sendCommand([
          'GEOSEARCH',
          key,
          'FROMLONLAT',
          String(query.longitude),
          String(query.latitude),
          'BYRADIUS',
          String(query.radiusM),
          'm',
        ])) as string[];
      } catch {
        /* Cassandra H3 조회로 복구한다. */
      }
    }
    let items = await this.filterCandidates(candidates, center, query.radiusM);
    if (items.length === 0) {
      const ids = new Set<string>();
      for (const cell of gridDisk(
        latLngToCell(query.latitude, query.longitude, 8),
        2,
      ))
        for (let shard = 0; shard < 16; shard++) {
          const page = await this.db.execute(
            'SELECT post_id FROM posts_by_cell WHERE cell = ? AND shard = ?',
            [cell, shard],
            { prepare: true },
          );
          for (const row of page.rows) ids.add(row.get('post_id'));
        }
      items = await this.filterCandidates([...ids], center, query.radiusM);
    }
    items.sort(
      (a, b) => a.distanceM - b.distanceM || a.postId.localeCompare(b.postId),
    );
    if (query.cursor) {
      let cursor: {
        latitude: number;
        longitude: number;
        radiusM: number;
        distanceM: number;
        postId: string;
      };
      try {
        cursor = JSON.parse(Buffer.from(query.cursor, 'base64url').toString());
        if (
          cursor.latitude !== query.latitude ||
          cursor.longitude !== query.longitude ||
          cursor.radiusM !== query.radiusM ||
          !Number.isFinite(cursor.distanceM) ||
          !POST_ID.test(cursor.postId)
        )
          throw new Error();
      } catch {
        throw new InvalidCursorError();
      }
      items = items.filter(
        (item) =>
          item.distanceM > cursor.distanceM ||
          (item.distanceM === cursor.distanceM && item.postId > cursor.postId),
      );
    }
    const page = items.slice(0, query.limit);
    const last = page.at(-1);
    return {
      items: page,
      nextCursor:
        items.length > query.limit && last
          ? Buffer.from(
              JSON.stringify({
                ...center,
                radiusM: query.radiusM,
                distanceM: last.distanceM,
                postId: last.postId,
              }),
            ).toString('base64url')
          : null,
    };
  }

  private async filterCandidates(
    ids: string[],
    center: { latitude: number; longitude: number },
    radiusM: number,
  ): Promise<NearbyResult['items']> {
    const items: NearbyResult['items'] = [];
    for (const id of new Set(ids)) {
      const row = (
        await this.db.execute(
          'SELECT latitude, longitude, expires_at FROM post_locations WHERE post_id = ?',
          [id],
          { prepare: true },
        )
      ).first();
      if (!row || (await this.getStatus(id)) !== 'ACTIVE') continue;
      const expiresAt = row.get('expires_at') as Date | null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) continue;
      const distance = distanceM(center, {
        latitude: row.get('latitude'),
        longitude: row.get('longitude'),
      });
      if (distance <= radiusM) items.push({ postId: id, distanceM: distance });
    }
    return items;
  }

  async rebuild(): Promise<number> {
    const staging = `map:posts:geo:build:${randomUUID()}`;
    if (!(await this.redis.set(REBUILD_KEY, staging, { NX: true })))
      throw new Error('Rebuild already active; inspect map:posts:geo:rebuild');
    let count = 0;
    try {
      let pageState: string | undefined;
      do {
        const page = await this.db.execute(
          'SELECT post_id, event_id, author_id, latitude, longitude, radius_m, category, expires_at, cell, shard FROM post_locations',
          [],
          { fetchSize: 100, pageState, autoPage: false },
        );
        for (const row of page.rows) {
          const post: PostCreated = {
            postId: row.get('post_id'),
            eventId: row.get('event_id'),
            authorId: Number(row.get('author_id')),
            latitude: row.get('latitude'),
            longitude: row.get('longitude'),
            radiusM: row.get('radius_m'),
            category: row.get('category'),
            expiresAt: row.get('expires_at'),
            cell: row.get('cell'),
            shard: row.get('shard'),
          };
          await this.writeCell(post);
          await this.db.execute(
            'INSERT INTO post_status (post_id, status) VALUES (?, ?) IF NOT EXISTS',
            [post.postId, 'ACTIVE'],
            { prepare: true },
          );
          if (
            (await this.getStatus(post.postId)) === 'ACTIVE' &&
            Math.abs(post.latitude) <= GEO_LATITUDE_LIMIT &&
            (!post.expiresAt || post.expiresAt.getTime() > Date.now())
          )
            await this.redis.geoAdd(staging, {
              longitude: post.longitude,
              latitude: post.latitude,
              member: post.postId,
            });
          count++;
        }
        pageState = page.pageState;
      } while (pageState);
      // 소비자 쓰기와 포인터 교체는 Redis에서 직렬화된다. 전환 직전 쓰기도 staging에 이미 반영된다.
      await this.redis.eval(
        `if redis.call('GET', KEYS[2]) ~= ARGV[1] then return redis.error_reply('Rebuild ownership lost') end
         local old = redis.call('GET', KEYS[1]) or ARGV[2]
         redis.call('SET', KEYS[1], ARGV[1]); redis.call('DEL', KEYS[2]); return old`,
        { keys: [ACTIVE_KEY, REBUILD_KEY], arguments: [staging, DEFAULT_GEO] },
      );
      return count;
    } catch (error) {
      // 실패한 staging은 공개하지 않는다. 다음 명령이 새 키에서 재시도할 수 있다.
      await this.redis.eval(
        `if redis.call('GET', KEYS[1]) == ARGV[1] then redis.call('DEL', KEYS[1]) end`,
        { keys: [REBUILD_KEY], arguments: [staging] },
      );
      throw error;
    }
  }
}

export class InvalidCursorError extends Error {}
