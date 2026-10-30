import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { emitRewardEvent } from './reward-events.js';
import {
  REWARD_POLICY,
  validatePolicy,
  levelFor,
  type RewardPolicy,
} from './reward-policy.js';

export interface ActivityRow {
  activity_key: string;
  post_id: string;
  kind: string;
  actor_id: string;
  beneficiary_id: string | null;
  reaction_type: string | null;
  version: string;
  active: boolean;
  event_id: string;
  correlation_id: string;
  comment_id: string | null;
  result_id: string | null;
  occurred_at: Date;
}
@Injectable()
export class RewardEngine {
  readonly policy: RewardPolicy;
  constructor(@Inject(REWARD_POLICY) policy: RewardPolicy) {
    this.policy = validatePolicy(policy);
  }

  async evaluate(
    m: EntityManager,
    a: ActivityRow,
    status: string,
    commentDeleted = false,
  ): Promise<void> {
    const p = this.policy;
    const eligible = ['POST_REACTION', 'COMMENT_REACTION', 'VOTE_WIN'].includes(
      a.kind,
    );
    const self = a.kind !== 'VOTE_WIN' && a.actor_id === a.beneficiary_id;
    let state =
      !eligible || self
        ? 'INELIGIBLE'
        : !a.beneficiary_id
          ? 'PENDING_CONTEXT'
          : !p.enabled
            ? 'PENDING_POLICY'
            : 'ELIGIBLE';
    if (!a.active || status !== 'ACTIVE') state = 'INACTIVE';
    await m.query(
      'UPDATE user_activities SET eligibility=$2 WHERE activity_key=$1',
      [a.activity_key, state],
    );
    if (!eligible || self || !p.enabled || !a.beneficiary_id) return;
    const amount =
      a.kind === 'POST_REACTION'
        ? (p.postReactions[a.reaction_type!] ?? 0)
        : a.kind === 'COMMENT_REACTION'
          ? (p.commentReactions[a.reaction_type!] ?? 0)
          : p.voteWinner;
    await this.ensurePolicy(m);
    const [user] = await m.query(
      'SELECT id,status FROM users WHERE id=$1 FOR UPDATE',
      [a.beneficiary_id],
    );
    if (!user) throw new Error('Reward beneficiary does not exist yet');
    const [entitlement] = await m.query(
      'SELECT * FROM reward_entitlements WHERE activity_key=$1',
      [a.activity_key],
    );
    const [original] = entitlement
      ? await m.query(
          'SELECT definition FROM reward_policies WHERE version=$1',
          [entitlement.policy_version],
        )
      : [];
    const effective: RewardPolicy = original?.definition ?? p;
    if (user.status !== 'ACTIVE')
      await m.query(
        "UPDATE user_activities SET eligibility='PENDING_ACCOUNT' WHERE activity_key=$1",
        [a.activity_key],
      );
    if (
      user.status !== 'ACTIVE' &&
      (!entitlement || !effective.revokeOnSanction)
    ) {
      await m.query(
        "UPDATE user_activities SET eligibility='PENDING_ACCOUNT' WHERE activity_key=$1",
        [a.activity_key],
      );
      return;
    }
    await m.query(
      'INSERT INTO user_growth(user_id) VALUES($1) ON CONFLICT DO NOTHING',
      [a.beneficiary_id],
    );
    const [balance] = await m.query(
      'SELECT * FROM user_growth WHERE user_id=$1 FOR UPDATE',
      [a.beneficiary_id],
    );
    const [paid] = await m.query(
      'SELECT COALESCE(sum(credits),0)::text AS credits FROM credit_ledger WHERE activity_key=$1',
      [a.activity_key],
    );
    const current = BigInt(paid.credits);
    const removed =
      (!a.active && effective.revokeOnRemoval) ||
      (commentDeleted &&
        (effective.revokeOnCommentDeletion ??
          effective.revokeOnPostDeletion)) ||
      (status === 'DELETED' && effective.revokeOnPostDeletion) ||
      (status === 'EXPIRED' && effective.revokeOnExpiry) ||
      (user.status !== 'ACTIVE' && effective.revokeOnSanction);
    // Removal events prove the activity existed. With a keep policy, a late create/remove
    // must produce the same entitlement as in-order delivery. Existing grants are not repriced.
    const desired = removed
      ? 0n
      : current > 0n
        ? current
        : BigInt(entitlement?.amount ?? amount);
    const delta = desired - current;
    if (delta > 0n) {
      if (
        user.status !== 'ACTIVE' ||
        (effective.maxGrantsPerActivity !== undefined &&
          (entitlement?.grants ?? 0) >= effective.maxGrantsPerActivity)
      ) {
        await m.query(
          "UPDATE user_activities SET eligibility='GRANT_LIMIT' WHERE activity_key=$1",
          [a.activity_key],
        );
        return;
      }
      // Budget the actual grant day, using the database clock. Historical delivery
      // must not bypass today's cap by supplying an older source timestamp.
      const [{ day }] = await m.query(
        'SELECT (now() AT TIME ZONE $1)::date::text AS day',
        [effective.dayTimeZone ?? 'UTC'],
      );
      const used = await m.query(
        `INSERT INTO reward_daily_usage(user_id,reward_day,credits_granted) SELECT $1,$2,$3::bigint
        WHERE ($4::bigint IS NULL OR $3::bigint<=$4::bigint)
        ON CONFLICT(user_id,reward_day) DO UPDATE SET credits_granted=reward_daily_usage.credits_granted+EXCLUDED.credits_granted
        WHERE ($4::bigint IS NULL OR reward_daily_usage.credits_granted+EXCLUDED.credits_granted<=$4::bigint) RETURNING user_id`,
        [
          a.beneficiary_id,
          day,
          delta.toString(),
          effective.dailyCreditLimit ?? null,
        ],
      );
      if (!used.length) {
        await m.query(
          "UPDATE user_activities SET eligibility='DAILY_LIMIT' WHERE activity_key=$1",
          [a.activity_key],
        );
        return;
      }
    }
    if (delta === 0n) return;
    const credits = BigInt(balance.credits) + delta,
      score = BigInt(balance.growth_score) + delta;
    const [entry] = await m.query(
      `INSERT INTO credit_ledger(user_id,activity_key,event_id,policy_version,credits,growth)
      VALUES($1,$2,$3,$4,$5,$5) ON CONFLICT DO NOTHING RETURNING id`,
      [
        a.beneficiary_id,
        a.activity_key,
        a.event_id,
        p.version,
        delta.toString(),
      ],
    );
    if (!entry)
      throw new Error(
        'Reward operation identity was reused after state changed',
      );
    if (delta > 0n)
      await m.query(
        `INSERT INTO reward_entitlements(activity_key,user_id,policy_version,amount,grants)
      VALUES($1,$2,$3,$4,1) ON CONFLICT(activity_key) DO UPDATE SET grants=reward_entitlements.grants+1`,
        [a.activity_key, a.beneficiary_id, p.version, desired.toString()],
      );
    const level = levelFor(score, p.levels);
    await m.query(
      'UPDATE user_growth SET credits=$2,growth_score=$3,level=$4,policy_version=$5 WHERE user_id=$1',
      [
        a.beneficiary_id,
        credits.toString(),
        score.toString(),
        level,
        p.version,
      ],
    );
    await this.emit(m, a, 'USER_CREDIT_CHANGED', {
      ledgerId: entry.id,
      delta: delta.toString(),
      credits: credits.toString(),
      growthScore: score.toString(),
      policyVersion: p.version,
    });
    if (level !== null && level !== balance.level) {
      await m.query(
        'INSERT INTO user_level_history(user_id,previous_level,level,policy_version) VALUES($1,$2,$3,$4)',
        [a.beneficiary_id, balance.level, level, p.version],
      );
      await this.emit(m, a, 'USER_LEVEL_CHANGED', {
        previousLevel: balance.level,
        level,
        changeType:
          balance.level === null
            ? 'INITIAL'
            : level > balance.level
              ? 'UP'
              : 'DOWN',
        growthScore: score.toString(),
        policyVersion: p.version,
      });
    }
  }
  private async ensurePolicy(m: EntityManager): Promise<void> {
    const p = this.policy;
    // A policy version is immutable; changing its definition under an old version fails closed.
    await m.query(
      'INSERT INTO reward_policies(version,definition) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [p.version, JSON.stringify(p)],
    );
    const [stored] = await m.query(
      'SELECT definition=$2::jsonb AS matches FROM reward_policies WHERE version=$1',
      [p.version, JSON.stringify(p)],
    );
    if (!stored.matches)
      throw new Error('Reward policy version was reused with different rules');
  }
  async syncBadges(m: EntityManager, a: ActivityRow): Promise<void> {
    if (!this.policy.enabled || !a.beneficiary_id) return;
    await this.ensurePolicy(m);
    const [user] = await m.query('SELECT status FROM users WHERE id=$1', [
      a.beneficiary_id,
    ]);
    if (!user) return;
    const [growth] = await m.query(
      'SELECT growth_score FROM user_growth WHERE user_id=$1',
      [a.beneficiary_id],
    );
    const score = BigInt(growth?.growth_score ?? 0);
    // A policy change can move a level without a new credit entry.
    const [storedLevel] = await m.query(
      'SELECT level FROM user_growth WHERE user_id=$1 FOR UPDATE',
      [a.beneficiary_id],
    );
    const level = levelFor(score, this.policy.levels);
    if (storedLevel && storedLevel.level !== level) {
      await m.query(
        'UPDATE user_growth SET level=$2,policy_version=$3 WHERE user_id=$1',
        [a.beneficiary_id, level, this.policy.version],
      );
      if (level !== null) {
        await m.query(
          'INSERT INTO user_level_history(user_id,previous_level,level,policy_version) VALUES($1,$2,$3,$4)',
          [a.beneficiary_id, storedLevel.level, level, this.policy.version],
        );
        await this.emit(m, a, 'USER_LEVEL_CHANGED', {
          previousLevel: storedLevel.level,
          level,
          changeType:
            storedLevel.level === null
              ? 'INITIAL'
              : level > storedLevel.level
                ? 'UP'
                : 'DOWN',
          growthScore: score.toString(),
          policyVersion: this.policy.version,
        });
      }
    }
    const [counts] = await m.query(
      `SELECT
      count(*) FILTER(WHERE a.kind='PARTICIPATION' AND a.actor_id=$1)::text AS participation,
      count(*) FILTER(WHERE a.kind IN ('POST_REACTION','COMMENT_REACTION') AND a.beneficiary_id=$1 AND a.actor_id<>a.beneficiary_id AND
        COALESCE(((CASE WHEN a.kind='POST_REACTION' THEN $2::jsonb ELSE $3::jsonb END)->>a.reaction_type)::bigint,0)>0)::text AS positive,
      count(*) FILTER(WHERE a.kind='VOTE_WIN' AND a.beneficiary_id=$1)::text AS wins
      FROM user_activities a LEFT JOIN reward_posts p ON p.post_id=a.post_id
      WHERE a.active AND COALESCE(p.status,'ACTIVE')='ACTIVE'
      AND NOT EXISTS(SELECT 1 FROM user_activities c WHERE c.kind='COMMENT' AND c.comment_id=a.comment_id AND c.post_id=a.post_id AND NOT c.active)`,
      [
        a.beneficiary_id,
        JSON.stringify(this.policy.postReactions),
        JSON.stringify(this.policy.commentReactions),
      ],
    );
    for (const rule of this.policy.badges) {
      const [badge] = await m.query(
        'SELECT id FROM badges WHERE code=$1 AND active=true',
        [rule.code],
      );
      if (!badge) throw new Error(`Configured badge is missing: ${rule.code}`);
      const [grant] = await m.query(
        'SELECT revoked_at FROM user_badges WHERE user_id=$1 AND badge_id=$2',
        [a.beneficiary_id, badge.id],
      );
      let qualifies =
        user.status === 'ACTIVE' &&
        score >= BigInt(rule.minimumScore) &&
        BigInt(counts.participation) >=
          BigInt(rule.minimumParticipation ?? 0) &&
        BigInt(counts.positive) >= BigInt(rule.minimumPositiveReactions ?? 0) &&
        BigInt(counts.wins) >= BigInt(rule.minimumVoteWins ?? 0);
      if (qualifies && rule.rankTop !== undefined) {
        const [rank] = await m.query(
          `SELECT position FROM (SELECT u.id,row_number() OVER(ORDER BY COALESCE(g.growth_score,0) DESC,u.id) AS position
          FROM users u LEFT JOIN user_growth g ON u.id=g.user_id WHERE u.status='ACTIVE') ranks WHERE id=$1`,
          [a.beneficiary_id],
        );
        qualifies = !!rank && BigInt(rank.position) <= BigInt(rule.rankTop);
      }
      if (qualifies && (!grant || grant.revoked_at !== null)) {
        await m.query(
          `INSERT INTO user_badges(user_id,badge_id,granted_at,revoked_at) VALUES($1,$2,now(),null)
          ON CONFLICT(user_id,badge_id) DO UPDATE SET granted_at=now(),revoked_at=null`,
          [a.beneficiary_id, badge.id],
        );
        await this.badgeChanged(m, a, badge.id, 'GRANTED');
      } else if (
        !qualifies &&
        (user.status !== 'ACTIVE'
          ? this.policy.revokeOnSanction === true
          : rule.revokeBelow) &&
        grant?.revoked_at === null
      ) {
        await m.query(
          'UPDATE user_badges SET revoked_at=now() WHERE user_id=$1 AND badge_id=$2',
          [a.beneficiary_id, badge.id],
        );
        await this.badgeChanged(m, a, badge.id, 'REVOKED');
      }
    }
  }
  private async badgeChanged(
    m: EntityManager,
    a: ActivityRow,
    badgeId: string,
    action: string,
  ) {
    await m.query(
      'INSERT INTO user_badge_history(user_id,badge_id,action,policy_version) VALUES($1,$2,$3,$4)',
      [a.beneficiary_id, badgeId, action, this.policy.version],
    );
    await this.emit(m, a, `USER_BADGE_${action}`, {
      badgeId,
      policyVersion: this.policy.version,
    });
  }
  private async emit(
    m: EntityManager,
    a: ActivityRow,
    type: string,
    payload: Record<string, unknown>,
  ) {
    await emitRewardEvent(
      m,
      a.beneficiary_id!,
      { eventId: a.event_id, correlationId: a.correlation_id },
      type,
      payload,
    );
  }
}
