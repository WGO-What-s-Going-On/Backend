import dataSource from '../database/data-source.js';
import { ActivityService } from './activity.service.js';
import { RewardEngine } from './reward-engine.js';
import { loadPolicy } from './reward-policy.js';
async function main() {
  const args = process.argv.slice(2),
    userId = args[args.indexOf('--user') + 1];
  if (
    !args.includes('--user') ||
    !userId ||
    !/^[1-9][0-9]{0,15}$/.test(userId) ||
    BigInt(userId) > 9007199254740991n
  )
    throw new Error(
      'Use --user <canonical user ID>; default is read-only reconciliation',
    );
  const policy = loadPolicy(
    process.env.USER_REWARD_POLICY_JSON,
    process.env.NODE_ENV,
  );
  const service = new ActivityService(dataSource, new RewardEngine(policy));
  const operation = args[args.indexOf('--operation-id') + 1];
  if (
    args.includes('--apply') &&
    (!args.includes('--operation-id') ||
      !operation ||
      !/^[a-zA-Z0-9:_-]{1,100}$/.test(operation))
  )
    throw new Error('--apply requires a stable --operation-id for retry');
  await dataSource.initialize();
  try {
    console.log(
      JSON.stringify({
        mode: args.includes('--apply') ? 'apply' : 'read-only',
        policyVersion: policy.version,
        enabled: policy.enabled,
        before: await service.reconcile(userId),
        titles: (await service.summary(userId)).titles,
      }),
    );
    if (args.includes('--apply')) {
      await service.reconcileUser(userId, operation!);
      await service.refreshUserTitles(userId);
      console.log(JSON.stringify({ after: await service.reconcile(userId) }));
    }
  } finally {
    await dataSource.destroy();
  }
}
main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
