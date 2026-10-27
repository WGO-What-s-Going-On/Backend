import { createClient } from 'redis';

// Maintenance command: pause old/new lifecycle writers before applying a page.
const args = process.argv.slice(2);
const apply = args.includes('--apply');
const cursor = args.find((a) => a.startsWith('--cursor='))?.slice(9) ?? '0';
if (
  !/^\d+$/.test(cursor) ||
  args.some((a) => a !== '--apply' && !a.startsWith('--cursor='))
)
  throw new Error('Usage: migrate-lifecycle-due.mjs [--cursor=0] [--apply]');
if (!process.env.REDIS_URL) throw new Error('Explicit REDIS_URL is required');
const redis = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  socket: { connectTimeout: 2000, reconnectStrategy: false },
  commandOptions: { timeout: 2000 },
});
redis.on('error', () => undefined);
try {
  await redis.connect();
  // COUNT is a Redis scan hint. One cursor page is processed per invocation.
  const page = await redis.sScan('moderation:lifecycle:posts', cursor, {
    COUNT: 100,
  });
  let migrated = 0,
    conflicts = 0;
  for (const id of page.members) {
    const key = `moderation:lifecycle:${id}`;
    const raw = await redis.get(key);
    if (!raw) {
      conflicts++;
      continue;
    }
    const p = JSON.parse(raw);
    if (p.postId !== id || !['ACTIVE', 'STALE', 'CLOSED'].includes(p.state))
      throw new Error('Invalid lifecycle projection; page not complete');
    const waiting = !!p.pendingPublication;
    const due = waiting
      ? Date.parse(p.pendingPublication.occurredAt) + 60000
      : p.state === 'STALE' && p.staleAt
        ? Date.parse(p.staleAt) + 600000
        : Math.max(
            Date.parse(p.createdAt) + 3600000,
            Date.parse(p.lastMeaningfulActivityAt) + 1800000,
          );
    if (!Number.isFinite(due))
      throw new Error('Invalid lifecycle timestamps; page not complete');
    if (!apply) continue;
    const updated = await redis.eval(
      `
      local t=redis.call('TYPE',KEYS[2]).ok
      if t~='none' and t~='zset' then return redis.error_reply('WRONGTYPE lifecycle due index') end
      if redis.call('GET',KEYS[1])~=ARGV[1] then return 0 end
      if ARGV[4]=='CLOSED' then redis.call('ZREM',KEYS[2],ARGV[2]);redis.call('SREM',KEYS[3],ARGV[2])
      else redis.call('ZADD',KEYS[2],ARGV[3],ARGV[2]) end
      return 1
    `,
      {
        keys: [key, 'moderation:lifecycle:due', 'moderation:lifecycle:posts'],
        arguments: [
          raw,
          id,
          String(due),
          waiting ? 'PENDING_PUBLICATION' : p.state,
        ],
      },
    );
    if (Number(updated) === 1) migrated++;
    else conflicts++;
  }
  console.log(
    JSON.stringify({
      mode: apply ? 'apply' : 'dry-run',
      cursor,
      nextCursor: page.cursor,
      inspected: page.members.length,
      migrated,
      conflicts,
    }),
  );
  if (conflicts) process.exitCode = 1;
} catch {
  console.error(
    'Lifecycle due migration failed; inspect the page and resume from its original cursor. Connection details suppressed.',
  );
  process.exitCode = 1;
} finally {
  if (redis.isOpen) await redis.quit();
}
