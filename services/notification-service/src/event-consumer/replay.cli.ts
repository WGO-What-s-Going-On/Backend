import { createClient } from 'redis';
import { deadStreams, replayFields } from './replay.js';
const args = process.argv.slice(2),
  apply = args.includes('--apply');
const value = (key: string) => args[args.indexOf(key) + 1];
const stream = value('--stream'),
  id = value('--entry');
if (
  !args.includes('--stream') ||
  !stream ||
  !deadStreams[stream] ||
  !args.includes('--entry') ||
  !id ||
  !/^\d+-\d+$/.test(id) ||
  args.some(
    (a) =>
      a.startsWith('--') && !['--apply', '--stream', '--entry'].includes(a),
  ) ||
  !process.env.REDIS_URL
)
  throw new Error(
    'Usage: events:replay --stream <source> --entry <DLQ stream ID> [--apply]; REDIS_URL required',
  );
const redis = createClient({
  url: process.env.REDIS_URL,
  disableOfflineQueue: true,
  socket: { reconnectStrategy: false, connectTimeout: 2000 },
});
redis.on('error', () => undefined);
try {
  await redis.connect();
  const rows = await redis.xRange(deadStreams[stream]!, id, id, { COUNT: 1 });
  if (rows.length !== 1) throw new Error('DLQ entry not found');
  const fields = replayFields(stream, rows[0]!.message);
  if (apply) {
    const appended = await redis.xAdd(stream, '*', fields);
    console.info(
      JSON.stringify({
        event: 'notification_redrive',
        stream,
        eventId: fields.eventId,
        streamId: appended,
      }),
    );
  } else
    console.info(
      JSON.stringify({
        dryRun: true,
        stream,
        eventId: fields.eventId,
        eventType: fields.eventType,
      }),
    );
  // Preserve the source DLQ and original eventId for audit and idempotent retries.
} catch {
  console.error('Notification DLQ replay failed; source entry preserved');
  process.exitCode = 1;
} finally {
  if (redis.isOpen) await redis.quit();
}
