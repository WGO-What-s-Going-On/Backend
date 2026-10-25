import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { WebSocket } from 'ws';
import { describe, expect, it, vi } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { PostClient } from '../src/realtime/post-client.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;
function wire(
  postId: string,
  eventType: string,
  changes: Record<string, unknown> = {},
) {
  const eventId = `evt_${randomUUID()}`;
  const now = new Date().toISOString();
  return {
    eventId,
    eventType,
    data: JSON.stringify({
      eventId,
      eventType,
      aggregateId: postId,
      producer: 'post-service',
      schemaVersion: 1,
      correlationId: 'req-test',
      occurredAt: now,
      post: { postId, expiredAt: now, deletedAt: now },
      postVersion: 2,
      ...changes,
    }),
  };
}

async function fixture(
  work: (f: {
    redis: ReturnType<typeof createClient>;
    sockets: WebSocket[];
    inboxes: Record<string, unknown>[][];
    command: (
      index: number,
      type: string,
      boardId: string,
    ) => Promise<Record<string, unknown>>;
    send: (fields: Record<string, string>) => Promise<void>;
    drain: () => Promise<void>;
    client: PostClient;
    restart: (index: number) => Promise<void>;
  }) => Promise<void>,
) {
  process.env.NODE_ENV = 'test';
  const config = loadConfig();
  config.redisUrl = 'redis://localhost:6380/10';
  const redis = createClient({ url: config.redisUrl });
  await redis.connect();
  await redis.flushDb(); // 이 suite 전용 DB.
  const client: PostClient = {
    canJoin: async () => true,
    detail: async () => ({}),
    comments: async () => ({ comments: [] }),
    createComment: async () => ({}),
  };
  const apps: Awaited<ReturnType<typeof buildApp>>[] = [];
  const sockets: WebSocket[] = [];
  const inboxes: Record<string, unknown>[][] = [];
  try {
    const open = async (i: number) => {
      const app = await buildApp({
        config,
        logger: false,
        authenticator: { authenticate: async () => ({ userId: '123' }) },
        postClient: client,
        enableEvents: true,
      });
      apps[i] = app;
      const address = await app.listen({ host: '127.0.0.1', port: 0 });
      const socket = new WebSocket(`${address.replace(/^http/, 'ws')}/ws/v1`);
      await new Promise<void>((resolve, reject) => {
        socket.once('open', resolve);
        socket.once('error', reject);
      });
      sockets[i] = socket;
      const inbox: Record<string, unknown>[] = [];
      inboxes[i] = inbox;
      socket.on('message', (data) => inbox.push(JSON.parse(data.toString())));
    };
    for (let i = 0; i < 2; i++) await open(i);
    const restart = async (i: number) => {
      sockets[i]!.terminate();
      await apps[i]!.close();
      await open(i);
    };
    const command = async (index: number, type: string, boardId: string) => {
      const requestId = randomUUID();
      sockets[index]!.send(
        JSON.stringify({
          version: 1,
          type,
          requestId,
          payload: { boardId, content: 'test', mutationId: randomUUID() },
        }),
      );
      let result: Record<string, unknown> | undefined;
      await vi.waitFor(
        () => {
          result = inboxes[index]!.find((m) => m.requestId === requestId);
          expect(result).toBeDefined();
        },
        { timeout: 5000 },
      );
      return result!;
    };
    const drain = async () => {
      await vi.waitFor(
        async () => {
          const groups = await redis.xInfoGroups('post:events');
          const group = groups.find((g) => g.name === 'post-realtime');
          expect(group?.lag).toBe(0);
          expect(group?.pending).toBe(0);
        },
        { timeout: 7000 },
      );
    };
    await work({
      redis,
      sockets,
      inboxes,
      command,
      client,
      restart,
      drain,
      send: async (fields) => {
        await redis.xAdd('post:events', '*', fields);
      },
    });
  } finally {
    for (const socket of sockets) socket.terminate();
    await Promise.all(apps.map((app) => app.close()));
    await redis.flushDb();
    await redis.quit();
  }
}

suite('Post lifecycle realtime delivery', () => {
  it.each([
    ['PostDeleted', 'post.deleted'],
    ['PostExpired', 'post.expired'],
  ])(
    'fans out %s then removes only that room on both instances',
    async (type, expected) => {
      await fixture(async (f) => {
        for (let i = 0; i < 2; i++) {
          expect((await f.command(i, 'board.join', 'post-ended')).type).toBe(
            'command.ack',
          );
          await f.command(i, 'board.join', 'post-other');
        }
        const fields = wire('post-ended', type!);
        await f.send(fields);
        await vi.waitFor(() => {
          for (const inbox of f.inboxes)
            expect(inbox.some((m) => m.type === expected)).toBe(true);
        });
        for (let i = 0; i < 2; i++) {
          expect(
            (await f.command(i, 'comment.create', 'post-ended')).code,
          ).toBe('WS_BOARD_NOT_JOINED');
          expect((await f.command(i, 'post.get', 'post-other')).type).toBe(
            'command.result',
          );
          expect(f.sockets[i]!.readyState).toBe(WebSocket.OPEN);
        }
        await f.send(fields);
        await f.send(wire('post-ended', 'PostCreated'));
        await f.drain();
        for (const inbox of f.inboxes)
          expect(
            inbox.filter((m) => m.postId === 'post-ended' && m.eventId),
          ).toHaveLength(1);
      });
    },
  );

  it('does not resurrect a deleted comment from duplicate or late creation events, using persisted consumer state', async () => {
    await fixture(async (f) => {
      for (let i = 0; i < 2; i++)
        await f.command(i, 'board.join', 'post-comment');
      const now = new Date().toISOString();
      const deleted = wire('post-comment', 'PostCommentDeleted', {
        activityVersion: 2,
        comment: {
          commentId: 'comment-1',
          postId: 'post-comment',
          deletedAt: now,
          content: 'removed secret',
        },
      });
      await f.send(deleted);
      await vi.waitFor(() => {
        for (const inbox of f.inboxes)
          expect(inbox.some((m) => m.type === 'comment.deleted')).toBe(true);
      });
      await f.send(deleted);
      await f.send(
        wire('post-comment', 'PostCommentCreated', {
          activityVersion: 1,
          comment: {
            commentId: 'comment-1',
            postId: 'post-comment',
            content: 'old body',
            createdAt: now,
          },
        }),
      );
      await f.drain();
      for (const inbox of f.inboxes) {
        expect(inbox.filter((m) => m.type === 'comment.deleted')).toHaveLength(
          1,
        );
        expect(inbox.some((m) => m.type === 'comment.created')).toBe(false);
        expect(JSON.stringify(inbox)).not.toContain('removed secret');
      }
      // Redis 상태는 로컬 seen 캐시와 독립적으로 남는다.
      expect(
        await f.redis.hGet(
          'post:realtime:state:post-comment',
          'deleted:comment-1',
        ),
      ).toBe('1');
      expect((await f.command(0, 'comment.list', 'post-comment')).type).toBe(
        'command.result',
      );
      await f.restart(0);
      await f.command(0, 'board.join', 'post-comment');
      await f.send(
        wire('post-comment', 'PostCommentCreated', {
          activityVersion: 1,
          comment: {
            commentId: 'comment-1',
            postId: 'post-comment',
            content: 'old body',
            createdAt: now,
          },
        }),
      );
      await f.send(wire('post-comment', 'PostReactionCreated'));
      await vi.waitFor(() =>
        expect(
          f.inboxes[0]!.some((m) => m.type === 'post.reaction.created'),
        ).toBe(true),
      );
      expect(f.inboxes[0]!.some((m) => m.type === 'comment.created')).toBe(
        false,
      );
    });
  });

  it('rejects a join whose authorization completes after the board expires', async () => {
    await fixture(async (f) => {
      let finish!: (allowed: boolean) => void;
      const entered = vi.fn();
      f.client.canJoin = async () => {
        entered();
        return new Promise((resolve) => {
          finish = resolve;
        });
      };
      const join = f.command(0, 'board.join', 'post-racing');
      await vi.waitFor(() => expect(entered).toHaveBeenCalled());
      await f.send(wire('post-racing', 'PostExpired'));
      await f.drain();
      finish(true);
      expect((await join).code).toBe('WS_BOARD_JOIN_FORBIDDEN');
      expect((await f.command(0, 'post.get', 'post-racing')).code).toBe(
        'WS_BOARD_NOT_JOINED',
      );
    });
  });

  it('quarantines malformed supported events and continues delivering later valid events', async () => {
    await fixture(async (f) => {
      await f.command(0, 'board.join', 'post-valid');
      await f.send({ eventId: 'broken', eventType: 'PostExpired', data: '{}' });
      await f.send(wire('post-valid', 'PostCreated'));
      await vi.waitFor(() =>
        expect(f.inboxes[0]!.some((m) => m.type === 'post.created')).toBe(true),
      );
      await f.drain();
      expect(await f.redis.xLen('post-realtime:dead')).toBe(1);
    });
  });

  it('requires reconnect and authoritative resync after Pub/Sub disconnect', async () => {
    await fixture(async (f) => {
      await f.command(0, 'board.join', 'post-resync');
      const closed = Promise.all(
        f.sockets.map(
          (socket) =>
            new Promise<number>((resolve) =>
              socket.once('close', (code) => resolve(code)),
            ),
        ),
      );
      // 다른 suite나 개발 연결을 건드리지 않고 전용 DB 10의 구독 연결만 끊는다.
      const clients = String(
        await f.redis.sendCommand(['CLIENT', 'LIST', 'TYPE', 'PUBSUB']),
      );
      for (const line of clients.trim().split('\n')) {
        const fields = Object.fromEntries(
          line.split(' ').map((part) => part.split('=')),
        );
        if (fields.db === '10')
          await f.redis.sendCommand(['CLIENT', 'KILL', 'ID', fields.id!]);
      }
      expect(await closed).toEqual([1012, 1012]);
    });
  });
});
