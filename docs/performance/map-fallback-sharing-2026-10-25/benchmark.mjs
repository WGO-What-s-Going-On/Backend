import { createRequire } from 'node:module';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
if (process.env.WGO_BENCH_ISOLATED !== '1')
  throw new Error('Use disposable Cassandra and Redis only');
const root = process.cwd();
const require = createRequire(`${root}/services/map-service/package.json`);
const cassandra = require('cassandra-driver');
const keyspace = `wgo_share_${randomUUID().replaceAll('-', '')}`;
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
    `${root}/services/map-service/dist/post-index-sharing-baseline.js`,
  )
);
const { PostIndex: Current } = await import(
  pathToFileURL(`${root}/services/map-service/dist/post-index.js`)
);
const groups = [
  [new Baseline(), new Baseline()],
  [new Current(), new Current()],
];
const counters = groups.map((group) =>
  group.map(() => ({ calls: 0, active: 0, peak: 0 })),
);
const records = [];
const percentile = (xs, p) =>
  [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * p) - 1];
try {
  for (let g = 0; g < 2; g++)
    for (let i = 0; i < 2; i++) {
      const client = groups[g][i];
      await client.connect();
      const original = client.db.execute.bind(client.db);
      client.db.execute = async (...args) => {
        const c = counters[g][i];
        c.calls++;
        c.active++;
        c.peak = Math.max(c.peak, c.active);
        try {
          return await original(...args);
        } finally {
          c.active--;
        }
      };
    }
  await groups[1][0].redis.flushDb();
  const query = { latitude: 37.5, longitude: 127, radiusM: 250, limit: 20 };
  for (const scenario of [
    'unknown-one-instance',
    'ready-one-instance',
    'unknown-two-instances',
  ]) {
    await groups[1][0].redis.flushDb();
    if (scenario.startsWith('ready')) await groups[1][0].rebuild();
    const instances = scenario.endsWith('two-instances') ? 2 : 1;
    const batch = async (g) => {
      for (const c of counters[g])
        Object.assign(c, { calls: 0, active: 0, peak: 0 });
      const started = performance.now();
      const durations = [];
      const outputs = await Promise.all(
        Array.from({ length: 20 }, async (_, n) => {
          const start = performance.now();
          const result = await groups[g][n % instances].nearby({
            ...query,
            latitude: query.latitude + n * 0.0000001,
          });
          durations.push(performance.now() - start);
          return result;
        }),
      );
      for (const output of outputs)
        assert.deepEqual(output, { items: [], nextCursor: null });
      return {
        calls: counters[g].reduce((sum, c) => sum + c.calls, 0),
        peakPerInstance: counters[g].slice(0, instances).map((c) => c.peak),
        wallMs: +(performance.now() - started).toFixed(2),
        durations,
      };
    };
    await batch(0);
    await batch(1);
    const samples = [[], []];
    for (let round = 0; round < 5; round++)
      for (const g of round % 2 ? [1, 0] : [0, 1])
        samples[g].push(await batch(g));
    const result = {
      scenario,
      requestsPerBatch: 20,
      batchesPerVariant: 5,
      variants: samples.map((runs, g) => {
        const times = runs.flatMap((r) => r.durations);
        return {
          name: g ? 'shared-and-certified' : 'parallel8-baseline',
          callsPerBatch: runs.map((r) => r.calls),
          requestP50Ms: +percentile(times, 0.5).toFixed(2),
          requestP95Ms: +percentile(times, 0.95).toFixed(2),
          samples: runs,
        };
      }),
    };
    records.push(result);
    console.log(JSON.stringify(result));
  }
  writeFileSync(
    new URL('./results.json', import.meta.url),
    JSON.stringify(records, null, 2) + '\n',
  );
} finally {
  await groups[1][0].redis.flushDb();
  for (const group of groups) for (const client of group) await client.close();
  await admin.execute(`DROP KEYSPACE ${keyspace}`);
  await admin.shutdown();
}
