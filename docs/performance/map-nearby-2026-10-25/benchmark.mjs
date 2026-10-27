import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
// Run only against the disposable Docker project created for this benchmark.
if (process.env.WGO_BENCH_ISOLATED !== '1')
  throw new Error(
    'Requires WGO_BENCH_ISOLATED=1 and disposable Cassandra/Redis',
  );
const root = process.cwd();
const require = createRequire(`${root}/services/map-service/package.json`);
const cassandra = require('cassandra-driver');
const { latLngToCell } = require('h3-js');
const keyspace = `wgo_bench_${randomUUID().replaceAll('-', '')}`;
const admin = new cassandra.Client({
  contactPoints: ['localhost'],
  localDataCenter: 'datacenter1',
});
await admin.connect();
for (const statement of readFileSync(
  `${root}/services/map-service/schema.cql`,
  'utf8',
)
  .replaceAll('wgo_map', keyspace)
  .split(';')
  .filter((s) => s.trim()))
  await admin.execute(statement);
process.env.CASSANDRA_KEYSPACE = keyspace;
process.env.REDIS_URL = 'redis://localhost:6381/14'; // Dedicated task-owned Docker Redis, DB14.
const { PostIndex: Baseline } = await import(
  pathToFileURL(`${root}/services/map-service/dist/post-index-baseline.js`)
);
const { PostIndex: Parallel } = await import(
  pathToFileURL(`${root}/services/map-service/dist/post-index.js`)
);
const clients = [new Baseline(), new Parallel()];
const stats = clients.map(() => ({ calls: 0, active: 0, peak: 0 }));
const results = [];
try {
  for (const [i, client] of clients.entries()) {
    await client.connect();
    const original = client.db.execute.bind(client.db);
    client.db.execute = async (...args) => {
      const s = stats[i];
      s.calls++;
      s.active++;
      s.peak = Math.max(s.peak, s.active);
      try {
        return await original(...args);
      } finally {
        s.active--;
      }
    };
  }
  const query = { latitude: 37.5, longitude: 127, radiusM: 250, limit: 20 };
  const percentile = (xs, p) =>
    [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
  for (const count of [0, 20, 200, 1000]) {
    for (const table of ['post_locations', 'post_status', 'posts_by_cell'])
      await admin.execute(`TRUNCATE ${keyspace}.${table}`);
    await clients[0].redis.flushDb();
    for (let n = 0; n < count; n++)
      await clients[0].write({
        postId: `post_${randomUUID()}`,
        eventId: `evt_${randomUUID()}`,
        authorId: 123,
        latitude: 37.5 + (n % 100) * 0.00001,
        longitude: 127,
        radiusM: 250,
        category: 'INCIDENT',
        expiresAt: null,
        cell: latLngToCell(37.5 + (n % 100) * 0.00001, 127, 8),
        shard: n % 16,
      });
    for (const mode of count ? ['geo', 'fallback'] : ['empty-fallback']) {
      if (mode === 'fallback') await clients[0].redis.del('map:posts:geo:v1');
      for (let warm = 0; warm < 2; warm++)
        for (const client of clients) await client.nearby(query);
      const times = [[], []],
        calls = [[], []],
        peaks = [[], []];
      for (let round = 0; round < 10; round++) {
        const outputs = [];
        for (const i of round % 2 ? [1, 0] : [0, 1]) {
          Object.assign(stats[i], { calls: 0, active: 0, peak: 0 });
          const started = performance.now();
          outputs[i] = await clients[i].nearby(query);
          times[i].push(performance.now() - started);
          calls[i].push(stats[i].calls);
          peaks[i].push(stats[i].peak);
        }
        assert.deepEqual(outputs[0], outputs[1]);
      }
      const record = {
        count,
        mode,
        samples: 10,
        variants: times.map((xs, i) => ({
          name: i ? 'parallel8' : 'sequential',
          medianMs: +percentile(xs, 0.5).toFixed(2),
          p95Ms: +percentile(xs, 0.95).toFixed(2),
          calls: [...new Set(calls[i])],
          maxInFlight: Math.max(...peaks[i]),
        })),
      };
      results.push(record);
      console.log(JSON.stringify(record));
    }
  }
  writeFileSync(
    new URL('./results.json', import.meta.url),
    JSON.stringify(results, null, 2) + '\n',
  );
} finally {
  await clients[0].redis.flushDb();
  for (const client of clients) await client.close();
  await admin.execute(`DROP KEYSPACE ${keyspace}`);
  await admin.shutdown();
}
