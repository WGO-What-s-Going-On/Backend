import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
if (process.env.WGO_BENCH_ISOLATED !== '1')
  throw new Error('Disposable DBs required');
const root = process.cwd();
const require = createRequire(`${root}/services/map-service/package.json`);
const cassandra = require('cassandra-driver');
const { latLngToCell } = require('h3-js');
const keyspace = `wgo_budget_${randomUUID().replaceAll('-', '')}`;
const admin = new cassandra.Client({
  contactPoints: ['localhost'],
  localDataCenter: 'datacenter1',
});
await admin.connect();
for (const sql of readFileSync(
  `${root}/services/map-service/schema.cql`,
  'utf8',
)
  .replaceAll('wgo_map', keyspace)
  .split(';')
  .filter((s) => s.trim()))
  await admin.execute(sql);
process.env.CASSANDRA_KEYSPACE = keyspace;
process.env.REDIS_URL = 'redis://localhost:6381/14';
const { PostIndex: Baseline } = await import(
  pathToFileURL(
    `${root}/services/map-service/dist/post-index-budget-baseline.js`,
  )
);
const { PostIndex: Current } = await import(
  pathToFileURL(`${root}/services/map-service/dist/post-index.js`)
);
const baseline = new Baseline(),
  current = new Current();
process.env.MAP_NEARBY_MAX_QUERIES = '32';
const capped = new Current();
delete process.env.MAP_NEARBY_MAX_QUERIES;
const clients = [baseline, current, capped];
const counts = [0, 0, 0];
const records = [];
try {
  for (let i = 0; i < 3; i++) {
    await clients[i].connect();
    const original = clients[i].db.execute.bind(clients[i].db);
    clients[i].db.execute = (...args) => {
      counts[i]++;
      return original(...args);
    };
  }
  await current.redis.flushDb();
  // Data preparation is outside all measured intervals. Batch eight independent writes.
  for (let offset = 0; offset < 2500; offset += 8)
    await Promise.all(
      Array.from({ length: Math.min(8, 2500 - offset) }, async (_, j) => {
        const n = offset + j;
        const latitude =
          37.5 + (n < 1000 ? 0.0005 : n < 2000 ? 0.0018 : 0.0027);
        await current.write({
          postId: `post_${randomUUID()}`,
          eventId: `evt_${randomUUID()}`,
          authorId: 123,
          latitude,
          longitude: 127,
          radiusM: 350,
          category: 'INCIDENT',
          expiresAt: null,
          cell: latLngToCell(latitude, 127, 8),
          shard: n % 16,
        });
      }),
    );
  await current.rebuild();
  for (const [label, radiusM, variant, deadlineMs] of [
    ['1000-geo', 150, 0, null],
    ['1000-geo', 150, 1, null],
    ['2000-geo', 250, 0, null],
    ['2000-geo', 250, 1, null],
    ['2500-geo', 350, 0, null],
    ['2500-geo', 350, 1, null],
    ['1000-query-cap32', 150, 2, null],
    ['1000-caller-deadline20', 150, 1, 20],
  ]) {
    const samples = [];
    for (let round = 0; round < 4; round++) {
      counts[variant] = 0;
      const start = performance.now();
      let outcome = 'OK';
      let items = null;
      try {
        const result = await clients[variant].nearby(
          { latitude: 37.5, longitude: 127, radiusM, limit: 20 },
          deadlineMs ? { deadline: Date.now() + deadlineMs } : {},
        );
        items = result.items;
      } catch (error) {
        outcome = error.code ?? error.name;
      }
      const elapsedMs = +(performance.now() - start).toFixed(2);
      const callsAtReturn = counts[variant];
      if (outcome !== 'OK')
        await new Promise((resolve) => setTimeout(resolve, 300));
      const callsAfterDrain = counts[variant];
      assert.equal(
        callsAfterDrain,
        callsAtReturn,
        'No new DB call after request ended',
      );
      if (outcome === 'OK') assert.equal(items.length, 20);
      if (round)
        samples.push({ outcome, elapsedMs, callsAtReturn, callsAfterDrain });
    }
    const result = {
      label,
      variant:
        variant === 0
          ? 'baseline'
          : variant === 1
            ? 'default-budget'
            : 'query-cap32',
      samples,
    };
    records.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(
    new URL('./results.json', import.meta.url),
    JSON.stringify(records, null, 2) + '\n',
  );
} finally {
  await current.redis.flushDb();
  for (const c of clients) await c.close();
  await admin.execute(`DROP KEYSPACE ${keyspace}`);
  await admin.shutdown();
}
