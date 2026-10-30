import { TITLE_CODES } from './title-policy.js';
export const REWARD_POLICY = Symbol('REWARD_POLICY');
export interface RewardPolicy {
  approved?: boolean;
  approvalReference?: string;
  dailyCreditLimit?: number;
  maxGrantsPerActivity?: number;
  dayTimeZone?: string;
  revokeOnCommentDeletion?: boolean;
  revokeOnSanction?: boolean;
  version: string;
  enabled: boolean;
  postReactions: Record<string, number>;
  commentReactions: Record<string, number>;
  voteWinner: number;
  revokeOnRemoval: boolean;
  revokeOnPostDeletion: boolean;
  revokeOnExpiry: boolean;
  levels: number[];
  badges: Array<{
    code: string;
    minimumScore: number;
    revokeBelow: boolean;
    rankTop?: number;
    minimumParticipation?: number;
    minimumPositiveReactions?: number;
    minimumVoteWins?: number;
  }>;
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
        !TITLE_CODES.includes(b.code as (typeof TITLE_CODES)[number]) &&
        b.code.trim() &&
        nonnegative(b.minimumScore) &&
        typeof b.revokeBelow === 'boolean',
    ) ||
    ![policy.dailyCreditLimit, policy.maxGrantsPerActivity].every(
      (n) => n === undefined || nonnegative(n),
    ) ||
    ![
      policy.revokeOnCommentDeletion,
      policy.revokeOnSanction,
      policy.approved,
    ].every((v) => v === undefined || typeof v === 'boolean') ||
    !policy.badges.every(
      (b) =>
        [
          b.minimumParticipation,
          b.minimumPositiveReactions,
          b.minimumVoteWins,
        ].every((n) => n === undefined || nonnegative(n)) &&
        (b.rankTop === undefined ||
          (Number.isSafeInteger(b.rankTop) &&
            b.rankTop > 0 &&
            b.rankTop <= 10000)) &&
        (b.code !== 'CLAIRVOYANT' || b.rankTop !== undefined),
    ) ||
    new Set(policy.badges.map((b) => b.code)).size !== policy.badges.length
  )
    throw new Error('Invalid reward policy');
  if (policy.dayTimeZone !== undefined) {
    try {
      new Intl.DateTimeFormat('en', { timeZone: policy.dayTimeZone }).format();
    } catch {
      throw new Error('Invalid reward day time zone');
    }
  }
  return policy;
}
export function levelFor(score: bigint, thresholds: number[]): number | null {
  if (!thresholds.length) return null;
  let level = 0;
  for (let i = 0; i < thresholds.length; i++)
    if (score >= BigInt(thresholds[i]!)) level = i;
  return level;
}

// An operator must explicitly supply approved, complete rules before production activation.
export function loadPolicy(
  raw: string | undefined,
  environment: string | undefined,
): RewardPolicy {
  const policy = raw ? validatePolicy(JSON.parse(raw)) : DISABLED_POLICY;
  if (
    environment === 'production' &&
    policy.enabled &&
    (policy.approved !== true ||
      !policy.approvalReference?.trim() ||
      policy.dailyCreditLimit === undefined ||
      policy.maxGrantsPerActivity === undefined ||
      !policy.dayTimeZone ||
      policy.revokeOnCommentDeletion === undefined ||
      policy.revokeOnSanction === undefined)
  )
    throw new Error(
      'Production rewards require approved explicit limits, time zone and revocation rules',
    );
  return policy;
}
