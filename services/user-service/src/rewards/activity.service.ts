import { Injectable, NotFoundException } from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { InvalidRewardEvent, type ActivityInput } from './post-event.js';
import { RewardEngine, type ActivityRow } from './reward-engine.js';
import { levelFor } from './reward-policy.js';
import type {
  CreditHistoryResponse,
  CreditHistoryItem,
  GrowthResponse,
} from './reward-response.dto.js';

@Injectable()
export class ActivityService {
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly engine: RewardEngine,
  ) {}

  async record(input: ActivityInput): Promise<void> {
    await this.db.transaction(async (m) => {
      const receipt = await m.query(
        'INSERT INTO reward_inbox(event_id) VALUES($1) ON CONFLICT DO NOTHING RETURNING event_id',
        [input.eventId],
      );
      if (!receipt.length) return;
      // All state for one post shares a fence, including terminal events and late children.
      await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        input.postId,
      ]);
      const [previous] = await m.query(
        'SELECT * FROM user_activities WHERE activity_key=$1',
        [input.key],
      );
      if (
        previous &&
        (previous.post_id !== input.postId ||
          previous.kind !== input.kind ||
          previous.actor_id !== input.actorId ||
          (previous.beneficiary_id !== null &&
            input.beneficiaryId !== null &&
            previous.beneficiary_id !== input.beneficiaryId) ||
          previous.reaction_type !== input.reactionType ||
          (BigInt(previous.version) === BigInt(input.version) &&
            previous.active !== input.active))
      ) {
        throw new InvalidRewardEvent(
          'Conflicting activity identity or version',
        );
      }
      if (input.postStatus)
        await m.query(
          `INSERT INTO reward_posts(post_id,version,status) VALUES($1,$2,$3)
        ON CONFLICT(post_id) DO UPDATE SET version=EXCLUDED.version,status=EXCLUDED.status
        WHERE reward_posts.version<EXCLUDED.version`,
          [input.postId, input.version, input.postStatus],
        );
      await m.query(
        `INSERT INTO user_activities(activity_key,post_id,kind,actor_id,beneficiary_id,reaction_type,version,active,event_id,correlation_id)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
        ON CONFLICT(activity_key) DO UPDATE SET version=EXCLUDED.version,active=EXCLUDED.active,
          beneficiary_id=COALESCE(user_activities.beneficiary_id,EXCLUDED.beneficiary_id),event_id=EXCLUDED.event_id,
          correlation_id=EXCLUDED.correlation_id,updated_at=now()
        WHERE user_activities.version<EXCLUDED.version`,
        [
          input.key,
          input.postId,
          input.kind,
          input.actorId,
          input.beneficiaryId,
          input.reactionType,
          input.version,
          input.active,
          input.eventId,
          input.correlationId,
        ],
      );
      const [post] = await m.query(
        'SELECT status FROM reward_posts WHERE post_id=$1',
        [input.postId],
      );
      const activities: ActivityRow[] = await m.query(
        'SELECT * FROM user_activities WHERE post_id=$1 ORDER BY beneficiary_id,activity_key',
        [input.postId],
      );
      // Sorted user locks avoid cycles when different posts reward the same users.
      const beneficiaries = [
        ...new Set(
          activities
            .map((a) => a.beneficiary_id)
            .filter((id): id is string => id !== null),
        ),
      ].sort((a, b) => (BigInt(a) < BigInt(b) ? -1 : 1));
      for (const id of beneficiaries)
        await m.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
      for (const a of activities)
        await this.engine.evaluate(
          m,
          {
            ...a,
            event_id: input.eventId,
            correlation_id: input.correlationId,
          },
          post?.status ?? 'ACTIVE',
        );
    });
  }

  async summary(userId: string): Promise<GrowthResponse> {
    // A single snapshot keeps balances and their progress calculation consistent.
    const [row] = await this.db.query(
      `SELECT u.id,g.credits,g.growth_score,g.level,g.policy_version FROM users u
      LEFT JOIN user_growth g ON g.user_id=u.id WHERE u.id=$1`,
      [userId],
    );
    if (!row) throw new NotFoundException('User not found');
    const p = this.engine.policy,
      score = BigInt(row.growth_score ?? '0');
    const level = p.enabled ? levelFor(score, p.levels) : null;
    return {
      credits: row.credits ?? '0',
      growthScore: score.toString(),
      level,
      policyVersion: row.policy_version ?? null,
      rewardsEnabled: p.enabled,
      levelFloor: level === null ? null : String(p.levels[level]),
      nextLevelScore:
        level === null || p.levels[level + 1] === undefined
          ? null
          : String(p.levels[level + 1]),
    };
  }
  async history(
    userId: string,
    limit: number,
    before: string | null,
  ): Promise<CreditHistoryResponse> {
    await this.summary(userId);
    const rows: Array<
      Omit<CreditHistoryItem, 'createdAt'> & { createdAt: Date }
    > = await this.db.query(
      `SELECT id,activity_key AS "activityKey",event_id AS "eventId",policy_version AS "policyVersion",
      credits AS delta,growth AS "growthDelta",created_at AS "createdAt" FROM credit_ledger
      WHERE user_id=$1 AND ($2::bigint IS NULL OR id<$2) ORDER BY id DESC LIMIT $3`,
      [userId, before, limit + 1],
    );
    const hasMore = rows.length > limit;
    const items = rows
      .slice(0, limit)
      .map((row) => ({ ...row, createdAt: row.createdAt.toISOString() }));
    return { items, nextCursor: hasMore ? items.at(-1)!.id : null };
  }
  async activityCounts(userId: string) {
    await this.summary(userId);
    return this.db.query(
      `SELECT a.kind,count(*)::text AS total,
      count(*) FILTER(WHERE a.active AND COALESCE(p.status,'ACTIVE')='ACTIVE')::text AS active
      FROM user_activities a LEFT JOIN reward_posts p ON p.post_id=a.post_id
      WHERE a.actor_id=$1 GROUP BY a.kind ORDER BY a.kind`,
      [userId],
    );
  }
  async reconcile(userId: string) {
    const [row] = await this.db.query(
      `SELECT COALESCE(g.credits,0)::text AS credits,COALESCE(g.growth_score,0)::text AS growth_score,
      COALESCE(sum(l.credits),0)::text AS "ledgerCredits",COALESCE(sum(l.growth),0)::text AS "ledgerGrowth"
      FROM users u LEFT JOIN user_growth g ON g.user_id=u.id LEFT JOIN credit_ledger l ON l.user_id=u.id
      WHERE u.id=$1 GROUP BY u.id,g.user_id`,
      [userId],
    );
    if (!row) throw new NotFoundException('User not found');
    return {
      consistent:
        row.credits === row.ledgerCredits &&
        row.growth_score === row.ledgerGrowth,
      ...row,
    };
  }
}
