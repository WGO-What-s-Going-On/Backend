import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PostConsumer } from '../src/post-consumer.js';
import {
  DEAD_STREAM,
  POST_GROUP,
  POST_STREAM,
  PostIndex,
} from '../src/post-index.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
suite('PostCreated spatial index with Cassandra and Redis', () => {
  let index: PostIndex;
  let consumer: PostConsumer;
  const event = () => {
    const postId = `post_${randomUUID()}`;
    const eventId = `evt_${randomUUID()}`;
    return {
      eventId,
      eventType: 'PostCreated',
      schemaVersion: 1,
      producer: 'post-service',
      aggregateId: postId,
      post: {
        postId,
        authorId: 123,
        latitude: 37.4979,
        longitude: 127.0276,
        radiusM: 250,
        category: 'INCIDENT',
        expiresAt: null,
      },
    };
  };
  const publish = async (data: unknown, fields: Record<string, string> = {}) =>
    index.redis.xAdd(POST_STREAM, '*', {
      eventId: (data as { eventId?: string })?.eventId ?? '',
      eventType: 'PostCreated',
      data: JSON.stringify(data),
      ...fields,
    });
  const read = async (name: string) => {
    const batch = await index.redis.xReadGroup(
      POST_GROUP,
      name,
      { key: POST_STREAM, id: '>' },
      { COUNT: 1 },
    );
    return (
      batch as Array<{
        messages: Array<{ id: string; message: Record<string, string> }>;
      }>
    )[0]!.messages[0]!;
  };

  beforeAll(async () => {
    process.env.REDIS_URL = 'redis://localhost:6381/15';
    index = new PostIndex();
    await index.connect();
    await index.redis.flushDb();
    consumer = new PostConsumer(index);
    await consumer.initialize();
  });
  afterAll(async () => {
    await index?.close();
  });

  it('stores a post in Cassandra, H3 cell and GEO, then accepts duplicate delivery', async () => {
    const data = event();
    await publish(data);
    await consumer.process(await read('first'));
    await publish(data);
    await consumer.process(await read('first'));
    const row = (
      await index.db.execute(
        'SELECT * FROM post_locations WHERE post_id = ?',
        [data.post.postId],
        { prepare: true },
      )
    ).first()!;
    expect(row.get('event_id')).toBe(data.eventId);
    expect(row.get('cell')).toMatch(/^8/);
    expect(
      (
        await index.db.execute(
          'SELECT * FROM posts_by_cell WHERE cell = ? AND shard = ? AND post_id = ?',
          [row.get('cell'), row.get('shard'), data.post.postId],
          { prepare: true },
        )
      ).rowLength,
    ).toBe(1);
    expect(
      await index.redis.geoPos('map:posts:geo:v1', data.post.postId),
    ).toEqual([expect.any(Object)]);
    expect((await consumer.metrics()).pending).toBe(0);
  });

  it('recovers a failed cell write from Pending', async () => {
    const data = event();
    await publish(data);
    const entry = await read('crashed');
    const original = index.writeCell.bind(index);
    index.writeCell = async () => {
      throw new Error('cell unavailable');
    };
    await consumer.process(entry);
    expect((await consumer.metrics()).pending).toBe(1);
    index.writeCell = original;
    const claimed = await index.redis.xAutoClaim(
      POST_STREAM,
      POST_GROUP,
      'recovery',
      0,
      '0-0',
    );
    await consumer.process(claimed.messages[0]!);
    expect((await consumer.metrics()).pending).toBe(0);
    expect(
      (
        await index.db.execute(
          'SELECT * FROM post_locations WHERE post_id = ?',
          [data.post.postId],
          { prepare: true },
        )
      ).rowLength,
    ).toBe(1);
  });

  it('recovers failures before the source write and before GEO', async () => {
    for (const stage of ['source', 'geo'] as const) {
      const data = event();
      await publish(data);
      const entry = await read(`failed-${stage}`);
      const original =
        stage === 'source'
          ? index.db.execute.bind(index.db)
          : index.writeGeo.bind(index);
      if (stage === 'source') {
        index.db.execute = (async () => {
          throw new Error('source unavailable');
        }) as typeof index.db.execute;
      } else
        index.writeGeo = async () => {
          throw new Error('geo unavailable');
        };
      await consumer.process(entry);
      if (stage === 'source')
        index.db.execute = original as typeof index.db.execute;
      else index.writeGeo = original as typeof index.writeGeo;
      const claimed = await index.redis.xAutoClaim(
        POST_STREAM,
        POST_GROUP,
        `recovered-${stage}`,
        0,
        '0-0',
      );
      await consumer.process(claimed.messages[0]!);
      expect(
        (
          await index.db.execute(
            'SELECT * FROM post_locations WHERE post_id = ?',
            [data.post.postId],
            { prepare: true },
          )
        ).rowLength,
      ).toBe(1);
      expect((await consumer.metrics()).pending).toBe(0);
    }
  });

  it('records malformed events in the dead letter stream and ACKs them', async () => {
    await publish({
      eventId: `evt_${randomUUID()}`,
      eventType: 'PostCreated',
      schemaVersion: 2,
    });
    await consumer.process(await read('bad'));
    expect(await index.redis.xLen(DEAD_STREAM)).toBe(1);
    expect((await consumer.metrics()).pending).toBe(0);
  });

  it('dead letters a persistent processing failure after five deliveries', async () => {
    const data = event();
    await publish(data);
    let entry = await read('failed-five');
    const original = index.writeGeo.bind(index);
    index.writeGeo = async () => {
      throw new Error('geo unavailable');
    };
    try {
      for (let attempt = 0; attempt < 5; attempt++) {
        await consumer.process(entry);
        if (attempt < 4) {
          const claimed = await index.redis.xAutoClaim(
            POST_STREAM,
            POST_GROUP,
            'failed-five',
            0,
            '0-0',
          );
          entry = claimed.messages[0]!;
        }
      }
    } finally {
      index.writeGeo = original;
    }
    expect((await consumer.metrics()).pending).toBe(0);
    expect(
      (await index.redis.xRange(DEAD_STREAM, '-', '+')).at(-1)?.message.eventId,
    ).toBe(data.eventId);
  });

  it('distributes messages across consumers and rebuilds a missing GEO index', async () => {
    const a = event(),
      b = event();
    await publish(a);
    await publish(b);
    const first = await read('worker-a');
    const second = await read('worker-b');
    expect(first.id).not.toBe(second.id);
    await consumer.process(first);
    await consumer.process(second);
    await index.redis.del('map:posts:geo:v1');
    expect(await index.redis.geoPos('map:posts:geo:v1', a.post.postId)).toEqual(
      [null],
    );
    expect(await index.rebuild()).toBeGreaterThanOrEqual(2);
    const active = await index.redis.get('map:posts:geo:active');
    expect(await index.redis.geoPos(active!, a.post.postId)).toEqual([
      expect.any(Object),
    ]);
  });

  it('keeps an event arriving during rebuild in the switched GEO key', async () => {
    const data = event();
    const original = index.writeCell.bind(index);
    let injected = false;
    index.writeCell = async (post) => {
      if (!injected) {
        injected = true;
        await publish(data);
        await consumer.process(await read('during-rebuild'));
      }
      await original(post);
    };
    try {
      await index.rebuild();
    } finally {
      index.writeCell = original;
    }
    const active = await index.redis.get('map:posts:geo:active');
    expect(await index.redis.geoPos(active!, data.post.postId)).toEqual([
      expect.any(Object),
    ]);
  });
});
