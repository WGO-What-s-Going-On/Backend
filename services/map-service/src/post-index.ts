import { cassandraOptions } from './cassandra-config.js';
import { createHash, randomUUID } from 'node:crypto';
import cassandra from 'cassandra-driver';
import { gridDisk, latLngToCell } from 'h3-js';
import { createClient } from 'redis';
import { distanceM, validCoordinates } from './location.js';
import {
  GEO_STATE,
  GEO_DIRTY,
  beginGeoWrite,
  inspectGeo,
  beforeGeoMutation,
  afterGeoMutation,
} from './geo-index-state.js';

import {
  NearbyBudget,
  NearbySearchError,
  nearbyLimits,
  type NearbyContext,
} from './nearby-budget.js';

type PartitionRead = {
  promise: Promise<string[]>;
  budgets: Set<NearbyBudget>;
  ids: Set<string>;
  pages: number;
};

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

// 요청당 동시에 검증하는 후보/파티션 수다. 총 조회량을 잘라 결과를 누락시키지는 않는다.
const NEARBY_READ_CONCURRENCY = 8;
async function forEachNearby<T>(
  values: T[],
  visit: (value: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  let failed = false;
  let failure: unknown;
  await Promise.all(
    Array.from(
      { length: Math.min(values.length, NEARBY_READ_CONCURRENCY) },
      async () => {
        while (!failed && next < values.length) {
          const value = values[next++]!;
          try {
            await visit(value);
          } catch (error) {
            if (!failed) failure = error;
            failed = true;
          }
        }
      },
    ),
  );
  // 실패 후 새 작업은 시작하지 않되 진행 중인 작업은 정리한 뒤 오류를 전파한다.
  if (failed) throw failure;
}

export class PostIndex {
  private readonly limits = nearbyLimits();
  private readonly partitionReads = new Map<string, PartitionRead>();

  private async beginWrite(token: string): Promise<void> {
    this.partitionReads.clear();
    // Redis에 미완료 쓰기를 기록하지 못하면 Cassandra 쓰기도 시작하지 않는다.
    await this.redis.eval(beginGeoWrite, {
      keys: [GEO_STATE, GEO_DIRTY],
      arguments: [token],
    });
  }
  private async finishWrite(token: string): Promise<void> {
    this.partitionReads.clear();
    await this.redis.sRem(GEO_DIRTY, token);
  }

  private async readPartition(
    cell: string,
    shard: number,
    budget: NearbyBudget,
  ): Promise<string[]> {
    budget.check();
    const key = `${cell}:${shard}`;
    let entry = this.partitionReads.get(key);
    if (!entry || entry.budgets.size === 0) {
      const shared: PartitionRead = {
        promise: undefined!,
        budgets: new Set(),
        ids: new Set(),
        pages: 0,
      };
      // 첫 대기자를 등록한 뒤 microtask에서 조회를 시작한다.
      shared.promise = Promise.resolve().then(async () => {
        let pageState: string | undefined;
        const forWaiters = (action: (b: NearbyBudget) => void) => {
          for (const waiter of shared.budgets) {
            try {
              action(waiter);
            } catch {
              shared.budgets.delete(waiter);
            }
          }
          if (shared.budgets.size === 0)
            throw new NearbySearchError('CANCELLED');
        };
        do {
          // 공유 페이지도 각 요청의 논리 조회 예산에 포함한다. 한 요청의 종료가 다른 요청을 중단시키지 않는다.
          forWaiters((b) => b.chargeQuery());
          shared.pages++;
          const page = await this.db.execute(
            'SELECT post_id FROM posts_by_cell WHERE cell = ? AND shard = ?',
            [cell, shard],
            {
              prepare: true,
              pageState,
              autoPage: false,
              fetchSize: 100,
              readTimeout: this.limits.readTimeoutMs,
              retry: new cassandra.policies.retry.FallthroughRetryPolicy(),
            },
          );
          const ids = page.rows.map((row) => row.get('post_id') as string);
          forWaiters((b) => b.addCandidates(ids));
          for (const id of ids) shared.ids.add(id);
          pageState = page.pageState;
        } while (pageState);
        return [...shared.ids];
      });
      if (this.partitionReads.size < 1024) this.partitionReads.set(key, shared);
      void shared.promise
        .finally(() => {
          if (this.partitionReads.get(key) === shared)
            this.partitionReads.delete(key);
        })
        .catch(() => {});
      entry = shared;
    }
    // 늦게 참여한 요청에도 이미 읽은 페이지와 후보의 예산을 적용한다.
    budget.chargeQuery(entry.pages);
    budget.addCandidates(entry.ids);
    entry.budgets.add(budget);
    try {
      return await budget.wait(entry.promise);
    } finally {
      entry.budgets.delete(budget);
      if (entry.budgets.size === 0 && this.partitionReads.get(key) === entry)
        this.partitionReads.delete(key);
    }
  }

  private async nearbyRead(sql: string, id: string, budget: NearbyBudget) {
    budget.chargeQuery();
    return budget.wait(
      this.db.execute(sql, [id], {
        prepare: true,
        readTimeout: Math.min(budget.remaining(), this.limits.readTimeoutMs),
        retry: new cassandra.policies.retry.FallthroughRetryPolicy(),
      }),
    );
  }

  readonly db = new cassandra.Client(cassandraOptions());
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
    await this.beginWrite(post.eventId);
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
    await this.refreshSpatial(post);
    await this.finishWrite(post.eventId);
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
    const token = `${event.postId}:${event.status}:${event.occurredAt.toISOString()}`;
    await this.beginWrite(token);
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
    // GEO를 먼저 제거하고 Cell 삭제까지 성공한 뒤에만 미완료 토큰을 해제한다.
    await this.removeGeo(event.postId);
    const location = (
      await this.db.execute(
        'SELECT cell, shard FROM post_locations WHERE post_id = ?',
        [event.postId],
        { prepare: true },
      )
    ).first();
    // 종료 이벤트가 생성보다 먼저 왔다면 위치가 없다. 늦은 생성의 refreshSpatial이 정리한다.
    if (location)
      await this.removeCell({
        postId: event.postId,
        cell: location.get('cell'),
        shard: location.get('shard'),
      });
    await this.finishWrite(token);
  }

  private async removeGeo(postId: string): Promise<void> {
    await this.redis.eval(
      `${beforeGeoMutation}
       redis.call('ZREM', active, ARGV[2])
       local staging = redis.call('GET', KEYS[2])
       if staging and staging ~= active then redis.call('ZREM', staging, ARGV[2]) end
       ${afterGeoMutation}`,
      {
        keys: [ACTIVE_KEY, REBUILD_KEY, GEO_STATE],
        arguments: [DEFAULT_GEO, postId],
      },
    );
  }

  private async removeCell(
    post: Pick<PostCreated, 'postId' | 'cell' | 'shard'>,
  ): Promise<void> {
    await this.db.execute(
      'DELETE FROM posts_by_cell WHERE cell = ? AND shard = ? AND post_id = ?',
      [post.cell, post.shard, post.postId],
      { prepare: true },
    );
  }

  private async refreshSpatial(
    post: PostCreated,
    staging?: string,
  ): Promise<boolean> {
    const active = async () =>
      (await this.getStatus(post.postId)) === 'ACTIVE' &&
      (!post.expiresAt || post.expiresAt.getTime() > Date.now());
    if (await active()) {
      await this.writeCell(post);
      if (staging) {
        if (Math.abs(post.latitude) <= GEO_LATITUDE_LIMIT)
          await this.redis.geoAdd(staging, {
            longitude: post.longitude,
            latitude: post.latitude,
            member: post.postId,
          });
      } else await this.writeGeo(post);
      // 상태 확인과 인덱스 쓰기는 원자적이지 않다. 중간에 종료됐다면 쓰기 후 다시 제거한다.
      if (await active()) return Math.abs(post.latitude) <= GEO_LATITUDE_LIMIT;
    }
    await this.removeGeo(post.postId);
    await this.removeCell(post);
    return false;
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
      `${beforeGeoMutation}
       redis.call('GEOADD', active, ARGV[2], ARGV[3], ARGV[4])
       local staging = redis.call('GET', KEYS[2])
       if staging and staging ~= active then redis.call('GEOADD', staging, ARGV[2], ARGV[3], ARGV[4]) end
       ${afterGeoMutation}`,
      {
        keys: [ACTIVE_KEY, REBUILD_KEY, GEO_STATE],
        arguments: [
          DEFAULT_GEO,
          String(post.longitude),
          String(post.latitude),
          post.postId,
        ],
      },
    );
  }

  async nearby(
    query: NearbyQuery,
    context: NearbyContext = {},
  ): Promise<NearbyResult> {
    const budget = new NearbyBudget(this.limits, context);
    try {
      return await this.searchNearby(query, budget);
    } catch (error) {
      if (error instanceof NearbySearchError && error.code !== 'CANCELLED')
        console.warn({
          event: 'map_nearby_budget_exceeded',
          code: error.code,
          ...budget.snapshot(),
        });
      throw error;
    } finally {
      budget.close();
    }
  }

  private async searchNearby(
    query: NearbyQuery,
    budget: NearbyBudget,
  ): Promise<NearbyResult> {
    budget.check();
    const center = { latitude: query.latitude, longitude: query.longitude };
    let candidates: string[] = [];
    let trusted = false;
    if (Math.abs(query.latitude) <= GEO_LATITUDE_LIMIT) {
      try {
        const result = (await budget.wait(
          this.redis
            .withCommandOptions({
              timeout: budget.remaining(),
              abortSignal: budget.controller.signal,
            })
            .eval(inspectGeo, {
              keys: [ACTIVE_KEY, REBUILD_KEY, GEO_STATE, GEO_DIRTY],
              arguments: [
                DEFAULT_GEO,
                String(query.longitude),
                String(query.latitude),
                String(query.radiusM),
                String(this.limits.maxCandidates + 1),
              ],
            }),
        )) as [number, string[]];
        trusted = result[0] === 1;
        candidates = result[1];
      } catch (error) {
        if (error instanceof NearbySearchError) throw error;
        budget.check();
        // Redis 장애·검증 실패에서는 Cassandra로 검색한다.
      }
    }
    budget.addCandidates(candidates);
    let items = trusted
      ? await this.filterCandidates(candidates, center, query.radiusM, budget)
      : [];
    if (!trusted) {
      const ids = new Set<string>(candidates);
      const partitions = gridDisk(
        latLngToCell(query.latitude, query.longitude, 8),
        2,
      ).flatMap((cell) =>
        Array.from({ length: 16 }, (_, shard) => ({ cell, shard })),
      );
      await forEachNearby(partitions, async ({ cell, shard }) => {
        for (const id of await this.readPartition(cell, shard, budget))
          ids.add(id);
      });
      items = await this.filterCandidates(
        [...ids],
        center,
        query.radiusM,
        budget,
      );
    }
    budget.check();
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
    budget.check();
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
    budget: NearbyBudget,
  ): Promise<NearbyResult['items']> {
    const items: NearbyResult['items'] = [];
    await forEachNearby([...new Set(ids)], async (id) => {
      const row = (
        await this.nearbyRead(
          'SELECT latitude, longitude, expires_at FROM post_locations WHERE post_id = ?',
          id,
          budget,
        )
      ).first();
      if (!row) return;
      const statusRow = (
        await this.nearbyRead(
          'SELECT status FROM post_status WHERE post_id = ?',
          id,
          budget,
        )
      ).first();
      if (statusRow?.get('status') !== 'ACTIVE') return;
      const expiresAt = row.get('expires_at') as Date | null;
      if (expiresAt && expiresAt.getTime() <= Date.now()) return;
      const distance = distanceM(center, {
        latitude: row.get('latitude'),
        longitude: row.get('longitude'),
      });
      if (distance <= radiusM) items.push({ postId: id, distanceM: distance });
    });
    return items;
  }

  async rebuild(): Promise<number> {
    const staging = `map:posts:geo:build:${randomUUID()}`;
    if (!(await this.redis.set(REBUILD_KEY, staging, { NX: true })))
      throw new Error('Rebuild already active; inspect map:posts:geo:rebuild');
    let count = 0;
    let geoCount = 0;
    try {
      // 완료 전까지 기존 인덱스도 미확인 상태다. 스캔 중 쓰기가 있으면 인증을 보류한다.
      await this.redis.hSet(GEO_STATE, 'ready', '0');
      const revision = (await this.redis.hGet(GEO_STATE, 'revision')) ?? '0';
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
          await this.db.execute(
            'INSERT INTO post_status (post_id, status) VALUES (?, ?) IF NOT EXISTS',
            [post.postId, 'ACTIVE'],
            { prepare: true },
          );
          if (await this.refreshSpatial(post, staging)) geoCount++;
          count++;
        }
        pageState = page.pageState;
      } while (pageState);
      // 소비자 쓰기와 포인터 교체는 Redis에서 직렬화된다. 전환 직전 쓰기도 staging에 이미 반영된다.
      await this.redis.eval(
        `if redis.call('GET', KEYS[2]) ~= ARGV[1] then return redis.error_reply('Rebuild ownership lost') end
         local old = redis.call('GET', KEYS[1]) or ARGV[2]
         redis.call('SET', KEYS[1], ARGV[1]); redis.call('DEL', KEYS[2]);
         local ready = '0'
         if (redis.call('HGET', KEYS[3], 'revision') or '0') == ARGV[3] and redis.call('SCARD', KEYS[4]) == 0 and redis.call('ZCARD', ARGV[1]) == tonumber(ARGV[4]) then ready = '1' end
         redis.call('HSET', KEYS[3], 'key', ARGV[1], 'count', redis.call('ZCARD', ARGV[1]), 'ready', ready)
         return old`,
        {
          keys: [ACTIVE_KEY, REBUILD_KEY, GEO_STATE, GEO_DIRTY],
          arguments: [staging, DEFAULT_GEO, revision, String(geoCount)],
        },
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
