import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
const require = createRequire(
  new URL('../services/map-service/package.json', import.meta.url),
);
const { createClient } = require('redis');
const url = process.env.REDIS_URL;
if (!url) throw new Error('REDIS_URL required');
const parsed = new URL(url);
if (
  parsed.protocol !== 'rediss:' &&
  !(
    process.env.REDIS_VERIFY_ALLOW_LOCAL === '1' &&
    ['localhost', '127.0.0.1'].includes(parsed.hostname)
  )
)
  throw new Error('Use TLS except explicit loopback verification');
const client = createClient({
  url,
  socket: {
    connectTimeout: 5000,
    reconnectStrategy: false,
    ...(process.env.REDIS_CA_PATH
      ? { tls: true, ca: readFileSync(process.env.REDIS_CA_PATH) }
      : {}),
  },
});
client.on('error', () => {});
const prefix = `wgo:verify:${randomUUID()}`;
const keys = ['stream', 'geo', 'lease', 'channel'].map(
  (suffix) => `${prefix}:${suffix}`,
);
const [stream, geo, lease, channel] = keys;
const subscriber = client.duplicate();
subscriber.on('error', () => {});
try {
  await client.connect();
  assert.equal(await client.ping(), 'PONG');
  const memory = await client.configGet('maxmemory-policy');
  assert.equal(
    memory['maxmemory-policy'],
    'noeviction',
    'domain state must not be evicted',
  );
  await client.geoAdd(geo, { longitude: 127, latitude: 37.5, member: 'seoul' });
  assert.equal(
    (
      await client.geoSearch(
        geo,
        { longitude: 127, latitude: 37.5 },
        { radius: 1, unit: 'km' },
      )
    ).length,
    1,
  );
  assert.equal(
    await client.eval(
      "if redis.call('EXISTS',KEYS[1]) == 0 then redis.call('SET',KEYS[1],ARGV[1],'EX',60); return 1 else return 0 end",
      { keys: [lease], arguments: ['owner-a'] },
    ),
    1,
  );
  assert.equal(await client.set(lease, 'owner-b', { NX: true }), null);
  await client.xGroupCreate(stream, 'verify', '0', { MKSTREAM: true });
  const id = await client.xAdd(stream, '*', { eventId: 'same-domain-event' });
  const first = await client.xReadGroup(
    'verify',
    'dead-worker',
    { key: stream, id: '>' },
    { COUNT: 1 },
  );
  assert.equal(first[0].messages[0].id, id);
  // No ACK before persistence. A replacement worker must be able to reclaim it.
  const claimed = await client.xAutoClaim(
    stream,
    'verify',
    'replacement-worker',
    0,
    '0-0',
    { COUNT: 1 },
  );
  assert.equal(claimed.messages[0].id, id);
  assert.equal(await client.xAck(stream, 'verify', id), 1);
  assert.equal((await client.xPending(stream, 'verify')).pending, 0);
  await subscriber.connect();
  let resolveMessage;
  const received = new Promise((resolve) => {
    resolveMessage = resolve;
  });
  await subscriber.subscribe(channel, (value) => resolveMessage(value));
  await client.publish(channel, 'reconnect-and-reauthorize');
  const timeout = setTimeout(() => resolveMessage('timeout'), 3000);
  assert.equal(await received, 'reconnect-and-reauthorize');
  clearTimeout(timeout);
  await subscriber.unsubscribe(channel);
  console.log(
    JSON.stringify({
      result: 'PASS',
      checks: [
        'TLS/auth when rediss',
        'noeviction',
        'GEO',
        'Lua lease',
        'Streams reclaim/ACK',
        'Pub/Sub',
      ],
      endpoint: parsed.hostname,
    }),
  );
} finally {
  if (subscriber.isOpen) await subscriber.quit();
  if (client.isOpen) {
    await client.del(keys);
    await client.quit();
  }
}
