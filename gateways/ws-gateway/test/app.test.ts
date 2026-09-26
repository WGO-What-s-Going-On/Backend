import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { buildApp } from '../src/app.js';
import { loadConfig, type AppConfig } from '../src/config.js';
import type { Authenticator } from '../src/realtime/authentication.js';
import type { BoardAccessAuthorizer } from '../src/realtime/board-access.js';
import type { PostClient } from '../src/realtime/post-client.js';

const apps: Array<{ close(): Promise<void> }> = [];
const sockets: WebSocket[] = [];

afterEach(async () => {
  for (const socket of sockets.splice(0)) socket.terminate();
  await Promise.all(apps.splice(0).map((app) => app.close()));
});

function testConfig(): AppConfig {
  process.env.NODE_ENV = 'test';
  process.env.LOG_PRETTY = 'false';
  return loadConfig();
}

const authenticator: Authenticator = {
  async authenticate() {
    return { userId: 'user-123' };
  },
};

function boardAccess(allowed: boolean): BoardAccessAuthorizer {
  return {
    async canJoin() {
      return allowed;
    },
  };
}

function nextMessage(socket: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    socket.once('message', (data) => {
      try {
        resolve(JSON.parse(data.toString()) as Record<string, unknown>);
      } catch (error) {
        reject(error);
      }
    });
    socket.once('error', reject);
  });
}

async function connect(allowed: boolean): Promise<WebSocket> {
  const app = await buildApp({
    config: testConfig(),
    logger: false,
    authenticator,
    boardAccessAuthorizer: boardAccess(allowed),
  });
  apps.push(app);
  await app.ready();
  const socket = await app.injectWS('/ws/v1');
  sockets.push(socket);
  return socket;
}

describe('realtime gateway', () => {
  it('requires room membership and returns post and comment results', async () => {
    const calls: unknown[] = [];
    const postClient: PostClient = {
      async canJoin() {
        return true;
      },
      async detail(id) {
        calls.push(['detail', id]);
        return { postId: id };
      },
      async comments(id, cursor, limit) {
        calls.push(['comments', id, cursor, limit]);
        return { comments: [], nextCursor: null };
      },
      async createComment(id, userId, content, mutationId) {
        calls.push(['create', id, userId, content, mutationId]);
        return { commentId: 'comment-1' };
      },
    };
    const app = await buildApp({
      config: testConfig(),
      logger: false,
      authenticator,
      postClient,
    });
    apps.push(app);
    await app.ready();
    const socket = await app.injectWS('/ws/v1');
    sockets.push(socket);
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'post.get',
        requestId: '1',
        payload: { boardId: 'post-1' },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.error',
      code: 'WS_BOARD_NOT_JOINED',
    });
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'board.join',
        requestId: '2',
        payload: { boardId: 'post-1' },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.ack',
    });
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'post.get',
        requestId: '3',
        payload: { boardId: 'post-1' },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.result',
      requestId: '3',
      result: { postId: 'post-1' },
    });
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'comment.list',
        requestId: '4',
        payload: { boardId: 'post-1', limit: 10 },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.result',
      requestId: '4',
      result: { comments: [], nextCursor: null },
    });
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'comment.create',
        requestId: '5',
        payload: { boardId: 'post-1', content: 'hello', mutationId: 'm1' },
      }),
    );
    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.result',
      requestId: '5',
      result: { commentId: 'comment-1' },
    });
    expect(calls).toEqual([
      ['detail', 'post-1'],
      ['comments', 'post-1', undefined, 10],
      ['create', 'post-1', 'user-123', 'hello', 'm1'],
    ]);
  });
  it('reports liveness and dependency readiness', async () => {
    const app = await buildApp({
      config: testConfig(),
      logger: false,
      authenticator,
      boardAccessAuthorizer: boardAccess(true),
    });
    apps.push(app);

    const live = await app.inject({ method: 'GET', url: '/health/live' });
    const ready = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(live.statusCode).toBe(200);
    expect(live.json()).toEqual({ status: 'ok' });
    expect(ready.json()).toMatchObject({
      status: 'ready',
      dependencies: { boardAuthorization: 'configured' },
    });
  });

  it('reports not-ready until board authorization is connected', async () => {
    const app = await buildApp({
      config: testConfig(),
      logger: false,
      authenticator,
    });
    apps.push(app);

    const response = await app.inject({ method: 'GET', url: '/health/ready' });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      status: 'not-ready',
      dependencies: { boardAuthorization: 'unavailable' },
    });
  });

  it('acknowledges an allowed board join on an authenticated connection', async () => {
    const socket = await connect(true);

    socket.send(
      JSON.stringify({
        version: 1,
        type: 'board.join',
        requestId: 'request-1',
        payload: { boardId: 'board-1' },
      }),
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.ack',
      requestId: 'request-1',
    });
  });

  it('does not add a socket to a board when domain authorization denies it', async () => {
    const socket = await connect(false);

    socket.send(
      JSON.stringify({
        version: 1,
        type: 'board.join',
        requestId: 'request-2',
        payload: { boardId: 'board-1' },
      }),
    );

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.error',
      requestId: 'request-2',
      code: 'WS_BOARD_JOIN_FORBIDDEN',
    });
  });

  it('returns a protocol error without closing the connection', async () => {
    const socket = await connect(true);

    socket.send('{invalid-json');

    await expect(nextMessage(socket)).resolves.toMatchObject({
      type: 'command.error',
      code: 'WS_INVALID_JSON',
    });
  });
});
