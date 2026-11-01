import { afterEach, describe, expect, it } from 'vitest';
import type { AddressInfo } from 'node:net';
import { createHttpServer } from '../src/server.js';
import type { Server } from 'node:http';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map(
        (server) =>
          new Promise<void>((resolve) => server.close(() => resolve())),
      ),
  );
});
describe('Map Kubernetes probes', () => {
  it('keeps liveness separate from failed dependency readiness', async () => {
    let available = true;
    const server = createHttpServer(
      { put: async (_, value) => value, get: async () => null },
      undefined,
      async () => {
        if (!available) throw new Error('backend unavailable');
        return true;
      },
    );
    servers.push(server);
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const address = server.address() as AddressInfo;
    const url = `http://127.0.0.1:${address.port}`;
    expect((await fetch(`${url}/health/ready`)).status).toBe(200);
    available = false;
    expect((await fetch(`${url}/health/ready`)).status).toBe(503);
    expect((await fetch(`${url}/health/live`)).status).toBe(200);
  });
});
