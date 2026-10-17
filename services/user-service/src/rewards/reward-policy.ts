export const REWARD_POLICY = Symbol('REWARD_POLICY');
export interface RewardPolicy {
  version: string;
  enabled: boolean;
  postReactions: Record<string, number>;
  commentReactions: Record<string, number>;
  voteWinner: number;
  revokeOnRemoval: boolean;
  revokeOnPostDeletion: boolean;
  revokeOnExpiry: boolean;
  levels: number[];
  badges: Array<{ code: string; minimumScore: number; revokeBelow: boolean }>;
}
export const DISABLED_POLICY: RewardPolicy = {
  version: 'unconfigured-v1',
  enabled: false,
  postReactions: {},
  commentReactions: {},
  voteWinner: 0,
  revokeOnRemoval: false,
  revokeOnPostDeletion: false,
  revokeOnExpiry: false,
  levels: [],
  badges: [],
};
export function validatePolicy(policy: RewardPolicy): RewardPolicy {
  const nonnegative = (n: unknown) => Number.isSafeInteger(n) && Number(n) >= 0;
  if (
    !policy ||
    typeof policy.version !== 'string' ||
    !policy.version.trim() ||
    typeof policy.enabled !== 'boolean' ||
    !['revokeOnRemoval', 'revokeOnPostDeletion', 'revokeOnExpiry'].every(
      (k) => typeof policy[k as keyof RewardPolicy] === 'boolean',
    ) ||
    !policy.postReactions ||
    !policy.commentReactions ||
    !Object.values(policy.postReactions).every(nonnegative) ||
    !Object.values(policy.commentReactions).every(nonnegative) ||
    !nonnegative(policy.voteWinner) ||
    !Array.isArray(policy.levels) ||
    !policy.levels.every(
      (n, i, a) => nonnegative(n) && (i === 0 ? n === 0 : n > a[i - 1]!),
    ) ||
    !Array.isArray(policy.badges) ||
    !policy.badges.every(
      (b) =>
        typeof b.code === 'string' &&
        b.code.trim() &&
        nonnegative(b.minimumScore) &&
        typeof b.revokeBelow === 'boolean',
    ) ||
    new Set(policy.badges.map((b) => b.code)).size !== policy.badges.length
  )
    throw new Error('Invalid reward policy');
  return policy;
}
export function levelFor(score: bigint, thresholds: number[]): number | null {
  if (!thresholds.length) return null;
  let level = 0;
  for (let i = 0; i < thresholds.length; i++)
    if (score >= BigInt(thresholds[i]!)) level = i;
  return level;
}
