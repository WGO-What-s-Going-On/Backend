import { createHash, randomUUID } from 'node:crypto';
import cassandra from 'cassandra-driver';
import { latLngToCell } from 'h3-js';
import { createClient } from 'redis';
import { validCoordinates } from './location.js';

export const POST_STREAM = 'post:events';
export const POST_GROUP = 'post-map';
export const DEAD_STREAM = 'map:post:dead';
const ACTIVE_KEY = 'map:posts:geo:active';
const REBUILD_KEY = 'map:posts:geo:rebuild';
const DEFAULT_GEO = 'map:posts:geo:v1';

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

const object = (value: unknown): value is Record<string, unknown> =>
  !!value && typeof value === 'object' && !Array.isArray(value);

export function parsePostCreated(raw: string | undefined, fields: Record<string, string>): PostCreated {
  let value: unknown;
  try { value = JSON.parse(raw ?? ''); } catch { throw new Error('Invalid data JSON'); }
  if (!object(value) || !object(value.post)) throw new Error('Invalid PostCreated envelope');
  const post = value.post;
  const uuid = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
  const id = new RegExp(`^post_${uuid}$`);
  const eventId = new RegExp(`^evt_${uuid}$`);
  if (value.eventType !== 'PostCreated' || fields.eventType !== 'PostCreated' ||
    value.schemaVersion !== 1 || value.producer !== 'post-service' ||
    typeof value.eventId !== 'string' || !eventId.test(value.eventId) ||
    value.eventId !== fields.eventId || typeof value.aggregateId !== 'string' ||
    !id.test(value.aggregateId) || post.postId !== value.aggregateId ||
    typeof post.postId !== 'string' || !id.test(post.postId) ||
    !Number.isSafeInteger(post.authorId) || (post.authorId as number) <= 0 ||
    typeof post.latitude !== 'number' || typeof post.longitude !== 'number' ||
    !validCoordinates(post.latitude, post.longitude) ||
    !Number.isInteger(post.radiusM) || (post.radiusM as number) < 1 || (post.radiusM as number) > 10000 ||
    typeof post.category !== 'string' || !/^[A-Z][A-Z_]*$/.test(post.category) || post.category.length > 40 ||
    !(post.expiresAt === null || (typeof post.expiresAt === 'string' &&
      Number.isFinite(Date.parse(post.expiresAt))))) throw new Error('Invalid PostCreated fields');
  const postId = post.postId as string;
  return {
    eventId: value.eventId, postId, authorId: post.authorId as number,
    latitude: post.latitude, longitude: post.longitude, radiusM: post.radiusM as number,
    category: post.category, expiresAt: post.expiresAt === null ? null : new Date(post.expiresAt as string),
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
  readonly redis = createClient({ url: process.env.REDIS_URL ?? 'redis://localhost:6381' });

  async connect(): Promise<void> {
    await this.db.connect();
    await this.redis.connect();
  }
  async close(): Promise<void> {
    if (this.redis.isOpen) await this.redis.quit();
    await this.db.shutdown();
  }

  async write(post: PostCreated): Promise<void> {
    // 원본을 먼저 저장한다. 중간에 실패하면 같은 이벤트를 다시 처리해 빠진 인덱스를 채운다.
    await this.db.execute(
      'INSERT INTO post_locations (post_id, event_id, author_id, latitude, longitude, radius_m, category, expires_at, cell, shard) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      [post.postId, post.eventId, cassandra.types.Long.fromNumber(post.authorId), post.latitude,
        post.longitude, post.radiusM, post.category, post.expiresAt, post.cell, post.shard],
      { prepare: true },
    );
    await this.writeCell(post);
    if (!post.expiresAt || post.expiresAt.getTime() > Date.now()) await this.writeGeo(post);
  }

  async writeCell(post: PostCreated): Promise<void> {
    await this.db.execute(
      'INSERT INTO posts_by_cell (cell, shard, post_id, latitude, longitude, radius_m, category, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      [post.cell, post.shard, post.postId, post.latitude, post.longitude, post.radiusM,
        post.category, post.expiresAt], { prepare: true },
    );
  }

  async writeGeo(post: PostCreated): Promise<void> {
    // 단일 Redis 명령에서 현재 GEO와 재구축 키에 함께 쓴다. 전환과 경합해도 새 게시물이 빠지지 않는다.
    await this.redis.eval(
      `local active = redis.call('GET', KEYS[1]) or ARGV[1]
       redis.call('GEOADD', active, ARGV[2], ARGV[3], ARGV[4])
       local staging = redis.call('GET', KEYS[2])
       if staging and staging ~= active then redis.call('GEOADD', staging, ARGV[2], ARGV[3], ARGV[4]) end
       return 1`,
      { keys: [ACTIVE_KEY, REBUILD_KEY], arguments: [DEFAULT_GEO, String(post.longitude), String(post.latitude), post.postId] },
    );
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
          [], { fetchSize: 100, pageState, autoPage: false },
        );
        for (const row of page.rows) {
          const post: PostCreated = {
            postId: row.get('post_id'), eventId: row.get('event_id'),
            authorId: Number(row.get('author_id')), latitude: row.get('latitude'),
            longitude: row.get('longitude'), radiusM: row.get('radius_m'),
            category: row.get('category'), expiresAt: row.get('expires_at'),
            cell: row.get('cell'), shard: row.get('shard'),
          };
          await this.writeCell(post);
          if (!post.expiresAt || post.expiresAt.getTime() > Date.now())
            await this.redis.geoAdd(staging, { longitude: post.longitude, latitude: post.latitude, member: post.postId });
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
