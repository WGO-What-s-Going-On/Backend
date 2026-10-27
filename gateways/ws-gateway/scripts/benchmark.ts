import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { WebSocket, type RawData } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import { HttpPostClient } from '../src/realtime/post-client.js';

const postRoot = new URL('../../../services/post-service/', import.meta.url)
  .pathname;
const port = 3302;
const postUrl = `http://127.0.0.1:${port}`;
const child = spawn(process.execPath, ['dist/main.js'], {
  cwd: postRoot,
  env: {
    ...process.env,
    NODE_ENV: 'development',
    PORT: String(port),
    MONGODB_URI:
      'mongodb://localhost:27017/wgo_post_realtime_benchmark?replicaSet=rs0',
    REDIS_URL: 'redis://localhost:6380',
  },
  stdio: 'inherit',
});

async function ready(): Promise<void> {
  for (let i = 0; i < 100; i++) {
    try {
      if ((await fetch(`${postUrl}/health/live`)).ok) return;
    } catch {
      /* starting */
    }
    await delay(100);
  }
  throw new Error('Post Service did not start');
}

function waitFor(
  socket: WebSocket,
  predicate: (value: Record<string, unknown>) => boolean,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error('WebSocket event timeout'));
    }, 5000);
    const onMessage = (raw: RawData) => {
      const value = JSON.parse(raw.toString()) as Record<string, unknown>;
      if (!predicate(value)) return;
      clearTimeout(timer);
      socket.off('message', onMessage);
      resolve(value);
    };
    socket.on('message', onMessage);
  });
}

const apps: Array<Awaited<ReturnType<typeof buildApp>>> = [];
const sockets: WebSocket[] = [];
try {
  await ready();
  const response = await fetch(`${postUrl}/api/v1/posts`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-User-Id': '123' },
    body: JSON.stringify({
      title: 'Latency test',
      content: 'realtime',
      category: 'INCIDENT',
      latitude: 37.5,
      longitude: 127,
      radiusM: 250,
    }),
  });
  if (!response.ok)
    throw new Error(`Post creation returned ${response.status}`);
  const { postId } = (await response.json()) as { postId: string };
  process.env.NODE_ENV = 'test';
  process.env.LOG_PRETTY = 'false';
  const config = loadConfig();
  config.postService.url = postUrl;
  for (let i = 0; i < 2; i++)
    apps.push(
      await buildApp({
        config,
        logger: false,
        authenticator: {
          async authenticate() {
            return { userId: '123' };
          },
        },
        postClient: new HttpPostClient(config.postService),
        enableEvents: true,
      }),
    );
  for (const app of apps) {
    await app.ready();
    sockets.push(await app.injectWS('/ws/v1'));
  }
  for (const socket of sockets) {
    const ack = waitFor(socket, (value) => value.requestId === 'join');
    socket.send(
      JSON.stringify({
        version: 1,
        type: 'board.join',
        requestId: 'join',
        payload: { boardId: postId },
      }),
    );
    const joined = await ack;
    if (joined.type !== 'command.ack')
      throw new Error(`Join failed: ${JSON.stringify(joined)}`);
  }
  const measurements: number[] = [];
  for (let i = 0; i < 100; i++) {
    const marker = randomUUID();
    const received = waitFor(
      sockets[1]!,
      (value) =>
        value.type === 'comment.created' &&
        (value.comment as Record<string, unknown>)?.content === marker,
    );
    const started = performance.now();
    sockets[0]!.send(
      JSON.stringify({
        version: 1,
        type: 'comment.create',
        requestId: marker,
        payload: { boardId: postId, content: marker, mutationId: marker },
      }),
    );
    await received;
    measurements.push(performance.now() - started);
  }
  measurements.sort((a, b) => a - b);
  const p95 = measurements[Math.ceil(measurements.length * 0.95) - 1]!;
  process.stdout.write(
    JSON.stringify({
      samples: measurements.length,
      p95Ms: p95,
      maxMs: measurements.at(-1),
      basis: 'command send to other gateway event receive',
    }) + '\n',
  );
  if (p95 > 500) process.exitCode = 1;
} finally {
  for (const socket of sockets) socket.terminate();
  await Promise.all(apps.map((app) => app.close()));
  child.kill('SIGTERM');
}
