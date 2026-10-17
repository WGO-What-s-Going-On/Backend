import { Inject, Injectable } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { OutboxEventEntity } from '../database/entities/outbox-event.entity.js';
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
    const [user] = await m.query(
      'SELECT id,status FROM users WHERE id=$1 FOR UPDATE',
      [a.beneficiary_id],
    );
    if (!user) throw new Error('Reward beneficiary does not exist yet');
    // Account sanctions need a separate contract; hold rewards for non-active accounts.
    if (user.status !== 'ACTIVE') {
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
      (!a.active && p.revokeOnRemoval) ||
      (status === 'DELETED' && p.revokeOnPostDeletion) ||
      (status === 'EXPIRED' && p.revokeOnExpiry);
    // Removal events prove the activity existed. With a keep policy, a late create/remove
    // must produce the same entitlement as in-order delivery. Existing grants are not repriced.
    const desired = removed ? 0n : current > 0n ? current : BigInt(amount);
    const delta = desired - current;
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
    if (!entry) return;
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
        growthScore: score.toString(),
        policyVersion: p.version,
      });
    }
    for (const rule of p.badges) {
      const [badge] = await m.query(
        'SELECT id FROM badges WHERE code=$1 AND active=true',
        [rule.code],
      );
      if (!badge) throw new Error(`Configured badge is missing: ${rule.code}`);
      const [grant] = await m.query(
        'SELECT revoked_at FROM user_badges WHERE user_id=$1 AND badge_id=$2',
        [a.beneficiary_id, badge.id],
      );
      const qualifies = score >= BigInt(rule.minimumScore);
      if (qualifies && (!grant || grant.revoked_at !== null)) {
        await m.query(
          `INSERT INTO user_badges(user_id,badge_id,granted_at,revoked_at) VALUES($1,$2,now(),null)
          ON CONFLICT(user_id,badge_id) DO UPDATE SET granted_at=now(),revoked_at=null`,
          [a.beneficiary_id, badge.id],
        );
        await this.badgeChanged(m, a, badge.id, 'GRANTED');
      } else if (!qualifies && rule.revokeBelow && grant?.revoked_at === null) {
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
    const eventId = randomUUID(),
      now = new Date();
    await m.getRepository(OutboxEventEntity).insert({
      eventId,
      aggregateId: a.beneficiary_id!,
      eventType: type,
      payload: {
        eventId,
        type,
        target: { type: 'USER', id: a.beneficiary_id },
        occurredAt: now.toISOString(),
        version: 1,
        producer: 'user-service',
        correlationId: a.correlation_id,
        payload: {
          userId: a.beneficiary_id,
          sourceEventId: a.event_id,
          ...payload,
        },
      },
      status: 'PENDING',
      publishAttempts: 0,
      createdAt: now,
      publishedAt: null,
    });
  }
}
