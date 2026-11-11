import { randomUUID } from 'node:crypto';
import { SignJWT } from 'jose';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { buildApp } from '../src/app.js';
import { loadConfig } from '../src/config.js';
import {
  authenticateTicket,
  RedisTicketUses,
  TicketStoreUnavailableError,
} from '../src/realtime/ticket-authentication.js';

const secret = 'ws-test-secret-at-least-32-bytes-long';
async function ticket(
  changes: Record<string, unknown> = {},
  typ = 'wgo-ws-ticket+jwt',
  key = secret,
) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({
    sub: '42',
    sid: randomUUID(),
    jti: randomUUID(),
    iss: 'wgo-http-gateway',
    aud: 'wgo-ws-gateway',
    iat: now,
    exp: now + 45,
    ...changes,
  })
    .setProtectedHeader({ alg: 'HS256', typ })
    .sign(new TextEncoder().encode(key));
}
const apps: Array<{ close(): Promise<void> }> = [];
const sockets: WebSocket[] = [];
afterEach(async () => {
  for (const s of sockets.splice(0)) s.terminate();
  await Promise.all(apps.splice(0).map((a) => a.close()));
});
function uses() {
  return { consume: vi.fn(async () => true), close: async () => {} };
}
it('accepts the dedicated ticket and never treats an access JWT as a ticket', async () => {
  const store = uses();
  expect(await authenticateTicket(await ticket(), secret, store)).toEqual({
    userId: '42',
  });
  await expect(
    authenticateTicket(await ticket({}, 'JWT'), secret, store),
  ).rejects.toThrow('invalid');
  expect(store.consume).toHaveBeenCalledTimes(1);
});
it.each([
  { exp: 1 },
  { exp: Math.floor(Date.now() / 1000) + 90 },
  { jti: '' },
  { sid: '' },
  { sub: '0' },
  { sub: '9007199254740992' },
  { aud: 'wgo-api' },
  { iss: 'wgo-user-service' },
  { iat: Math.floor(Date.now() / 1000) + 30 },
])('rejects invalid ticket claims before Redis: %j', async (changes) => {
  const store = uses();
  await expect(
    authenticateTicket(await ticket(changes), secret, store),
  ).rejects.toThrow('invalid');
  expect(store.consume).not.toHaveBeenCalled();
});
it('rejects forged and reused tickets and exposes storage outage separately', async () => {
  const store = uses();
  await expect(
    authenticateTicket(
      await ticket(
        {},
        'wgo-ws-ticket+jwt',
        'wrong-key-that-is-long-enough-123456789',
      ),
      secret,
      store,
    ),
  ).rejects.toThrow('invalid');
  store.consume.mockResolvedValueOnce(false);
  await expect(
    authenticateTicket(await ticket(), secret, store),
  ).rejects.toThrow('already used');
  store.consume.mockRejectedValueOnce(new TicketStoreUnavailableError());
  await expect(
    authenticateTicket(await ticket(), secret, store),
  ).rejects.toBeInstanceOf(TicketStoreUnavailableError);
});
it('preserves origin checks and never falls back from invalid or duplicate tickets', async () => {
  const store = uses();
  const authenticate = vi.fn(async () => ({ userId: '42' }));
  const app = await buildApp({
    config: loadConfig(),
    logger: false,
    authenticator: { authenticate },
    ticketUses: store,
    boardAccessAuthorizer: { canJoin: async () => true },
  });
  apps.push(app);
  for (const url of [
    '/ws/v1?ticket=',
    '/ws/v1?ticket=bad',
    '/ws/v1?ticket=a&ticket=b',
  ]) {
    expect((await app.inject({ url })).statusCode).toBe(401);
  }
  expect(
    (
      await app.inject({
        url: `/ws/v1?ticket=${await ticket()}`,
        headers: { origin: 'https://evil.test' },
      })
    ).statusCode,
  ).toBe(403);
  expect(authenticate).not.toHaveBeenCalled();
  expect(store.consume).not.toHaveBeenCalled();
});
it('returns 503 on ticket store outage instead of falling back to a cookie', async () => {
  const store = uses();
  store.consume.mockRejectedValue(new TicketStoreUnavailableError());
  const app = await buildApp({
    config: loadConfig(),
    logger: false,
    ticketUses: store,
  });
  apps.push(app);
  const result = await app.inject({
    url: `/ws/v1?ticket=${await ticket()}`,
    headers: { cookie: 'wgo_access_token=ignored' },
  });
  expect(result.statusCode).toBe(503);
  expect(result.json().code).toBe('WS_TICKET_UNAVAILABLE');
});

const integration =
  process.env.RUN_REDIS_TICKET_INTEGRATION === '1' ? describe : describe.skip;
integration('ticket handshake with shared real Redis', () => {
  it('allows exactly one concurrent connection across gateway instances and retains room authorization', async () => {
    const config = loadConfig();
    const first = await buildApp({
      config,
      logger: false,
      boardAccessAuthorizer: { canJoin: async () => false },
    });
    const second = await buildApp({
      config,
      logger: false,
      boardAccessAuthorizer: { canJoin: async () => false },
    });
    apps.push(first, second);
    await Promise.all([first.ready(), second.ready()]);
    const url = `/ws/v1?ticket=${await ticket()}`;
    const results = await Promise.allSettled([
      first.injectWS(url),
      second.injectWS(url),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    for (const result of results)
      if (result.status === 'fulfilled') {
        const socket = result.value;
        sockets.push(socket);
        const message = new Promise((resolve) =>
          socket.once('message', (data) =>
            resolve(JSON.parse(data.toString())),
          ),
        );
        socket.send(
          JSON.stringify({
            version: 1,
            type: 'board.join',
            requestId: 'denied',
            payload: { boardId: 'post-1' },
          }),
        );
        expect(await message).toMatchObject({ type: 'command.error' });
      }
    await expect(first.injectWS(url)).rejects.toThrow();
  });
  it('bounds connection failure and fails closed', async () => {
    const store = new RedisTicketUses('redis://127.0.0.1:1');
    try {
      await expect(store.consume(randomUUID())).rejects.toBeInstanceOf(
        TicketStoreUnavailableError,
      );
    } finally {
      await store.close();
    }
  });
});
