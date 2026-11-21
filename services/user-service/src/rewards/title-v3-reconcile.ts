import dataSource from '../database/data-source.js';
import { TitleService } from './title.service.js';
import { parseUserId } from '../user-id.js';

async function main() {
  const args = process.argv.slice(2);
  const userId = parseUserId(args[args.indexOf('--user') + 1]);
  const apply = args.includes('--apply');
  const operation = args[args.indexOf('--operation-id') + 1];
  if (!args.includes('--user') || !userId)
    throw new Error('Use --user <canonical user ID>');
  if (
    apply &&
    (!args.includes('--operation-id') ||
      !operation ||
      !/^[a-zA-Z0-9:_-]{1,100}$/.test(operation))
  )
    throw new Error('--apply requires a stable --operation-id');
  const titles = new TitleService();
  if (apply && !titles.v3.enabled)
    throw new Error('v3 awards are OFF; only comparison is permitted');
  await dataSource.initialize();
  try {
    const before = await dataSource.transaction(
      'REPEATABLE READ',
      async (m) => {
        await m.query('SET TRANSACTION READ ONLY');
        return titles.v3.compare(m, userId);
      },
    );
    console.log(
      JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...before }),
    );
    if (apply) {
      // No RewardEngine calls: reconciliation cannot reprice credits or growth levels.
      await dataSource.transaction(async (m) => {
        await titles.lock(m);
        await titles.syncUser(m, userId, {
          eventId: `title-v3:${operation}:${userId}`,
          correlationId: `title-v3:${operation}`,
          notificationMode: 'silent',
        });
      });
    }
  } finally {
    await dataSource.destroy();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
