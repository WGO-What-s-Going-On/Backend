import { randomUUID } from 'node:crypto';
import { createClient } from 'redis';
import { WebSocket } from 'ws';
import { describe, expect, it } from 'vitest';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import type { PostClient } from '../src/realtime/post-client.js';

const suite = process.env.RUN_INTEGRATION === '1' ? describe : describe.skip;

function receive(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve) => socket.once('message', (raw) => resolve(JSON.parse(raw.toString()) as Record<string, unknown>)));
}

suite('distributed post events', () => {
  it('reclaims a pending event after a consumer stops before publishing', async () => {
    process.env.NODE_ENV = 'test';
    process.env.LOG_PRETTY = 'false';
    const config = loadConfig();
    const redis = createClient({ url: config.redisUrl });
    await redis.connect();
    await redis.del('post:events');
    await redis.xGroupCreate('post:events', 'post-realtime', '0', { MKSTREAM: true });
    const eventId = randomUUID();
    await redis.xAdd('post:events', '*', { eventId, eventType: 'PostCreated', data: JSON.stringify({ eventId, eventType: 'PostCreated', aggregateId: 'post-recovery' }) });
    await redis.xReadGroup('post-realtime', 'stopped-consumer', { key: 'post:events', id: '>' }, { COUNT: 1 });
    expect((await redis.xPending('post:events', 'post-realtime')).pending).toBe(1);
    const postClient: PostClient = {
      async canJoin() { return true; }, async detail() { return {}; },
      async comments() { return {}; }, async createComment() { return {}; },
    };
    const app = await buildApp({ config, logger: false, authenticator: { async authenticate() { return { userId: '123' }; } }, postClient, enableEvents: true });
    await app.ready();
    const socket = await app.injectWS('/ws/v1');
    try {
      socket.send(JSON.stringify({ version: 1, type: 'board.join', requestId: 'join', payload: { boardId: 'post-recovery' } }));
      expect((await receive(socket)).type).toBe('command.ack');
      const recovered = await Promise.race([
        receive(socket),
        new Promise<never>((_, reject) => setTimeout(() => reject(new Error('pending event not reclaimed')), 8000)),
      ]);
      expect(recovered).toMatchObject({ type: 'post.created', eventId });
      for (let i = 0; i < 20 && (await redis.xPending('post:events', 'post-realtime')).pending !== 0; i++) await new Promise((resolve) => setTimeout(resolve, 25));
      expect((await redis.xPending('post:events', 'post-realtime')).pending).toBe(0);
    } finally {
      socket.terminate(); await app.close(); await redis.quit();
    }
  }, 20000);

  it('delivers all four event types to joined rooms on two gateway instances', async () => {
    process.env.NODE_ENV = 'test';
    process.env.LOG_PRETTY = 'false';
    const config = loadConfig();
    const redis = createClient({ url: config.redisUrl });
    await redis.connect();
    await redis.del('post:events');
    const postClient: PostClient = {
      async canJoin() { return true; },
      async detail(id) { return { postId: id }; },
      async comments() { return { comments: [], nextCursor: null }; },
      async createComment() { return { commentId: 'created' }; },
    };
    const options = { config, logger: false as const, authenticator: { async authenticate() { return { userId: '123' }; } }, postClient, enableEvents: true };
    const first = await buildApp(options);
    const second = await buildApp(options);
    const sockets: WebSocket[] = [];
    try {
      await Promise.all([first.ready(), second.ready()]);
      const a = await first.injectWS('/ws/v1');
      const b = await second.injectWS('/ws/v1');
      const outsider = await second.injectWS('/ws/v1');
      sockets.push(a, b, outsider);
      for (const socket of [a, b]) {
        socket.send(JSON.stringify({ version: 1, type: 'board.join', requestId: randomUUID(), payload: { boardId: 'post-1' } }));
        expect((await receive(socket)).type).toBe('command.ack');
      }
      outsider.send(JSON.stringify({ version: 1, type: 'board.join', requestId: 'other', payload: { boardId: 'post-2' } }));
      await receive(outsider);
      let leaked = false;
      outsider.on('message', () => { leaked = true; });
      for (const [eventType, expected] of ([
        ['PostCreated', 'post.created'], ['PostCommentCreated', 'comment.created'],
        ['PostReactionCreated', 'post.reaction.created'], ['PostParticipantJoined', 'post.participant.joined'],
      ] as const)) {
        const eventId = randomUUID();
        const payload = { eventId, eventType, aggregateId: 'post-1', ...(eventType === 'PostCommentCreated' ? { comment: { commentId: randomUUID(), postId: 'post-1', content: 'hello' } } : {}) };
        const responses = [receive(a), receive(b)];
        await redis.xAdd('post:events', '*', { eventId, eventType, data: JSON.stringify(payload) });
        for (const response of responses) expect(await response).toMatchObject({ type: expected, eventId, postId: 'post-1' });
      }
      expect(leaked).toBe(false);
    } finally {
      for (const socket of sockets) socket.terminate();
      await Promise.all([first.close(), second.close()]);
      await redis.quit();
    }
  }, 20000);
});
