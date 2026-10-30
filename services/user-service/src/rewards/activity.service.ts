import { Injectable, NotFoundException, Optional } from '@nestjs/common';
import { TitleService } from './title.service.js';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ConflictingRewardEvent, type ActivityInput } from './post-event.js';
import { RewardEngine, type ActivityRow } from './reward-engine.js';
import { levelFor } from './reward-policy.js';
import type {
  CreditHistoryResponse,
  CreditHistoryItem,
  GrowthResponse,
} from './reward-response.dto.js';

@Injectable()
export class ActivityService {
  private readonly titles: TitleService;
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly engine: RewardEngine,
    @Optional() titles?: TitleService,
  ) {
    this.titles = titles ?? new TitleService();
  }

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
      await this.titles.lock(m);
      if (input.regionUpdate) {
        await this.titles.recordRegion(
          m,
          input.postId,
          input.regionUpdate.version,
          input.regionUpdate.region,
          input.eventId,
        );
        return;
      }
      if (input.postRegion)
        await this.titles.recordRegion(
          m,
          input.postId,
          input.postRegion.version,
          input.postRegion,
          input.eventId,
        );
      const [previous] = await m.query(
        'SELECT * FROM user_activities WHERE activity_key=$1 OR ($2::text IS NOT NULL AND result_id=$2)',
        [input.key, input.resultId ?? null],
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
          (previous.comment_id !== null &&
            input.commentId !== undefined &&
            previous.comment_id !== input.commentId) ||
          (previous.result_id !== null &&
            previous.result_id !== (input.resultId ?? null)) ||
          (BigInt(previous.version) === BigInt(input.version) &&
            previous.active !== input.active))
      ) {
        throw new ConflictingRewardEvent(
          'Conflicting activity identity or version',
        );
      }
      if (previous) input = { ...input, key: previous.activity_key };
      if (input.postStatus)
        await m.query(
          `INSERT INTO reward_posts(post_id,version,status) VALUES($1,$2,$3)
        ON CONFLICT(post_id) DO UPDATE SET version=EXCLUDED.version,status=EXCLUDED.status
        WHERE reward_posts.version<EXCLUDED.version`,
          [input.postId, input.version, input.postStatus],
        );
      const changedActivities = await m.query(
        `INSERT INTO user_activities(activity_key,post_id,kind,actor_id,beneficiary_id,reaction_type,version,active,event_id,correlation_id,comment_id,result_id,occurred_at,source_time_verified)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT(activity_key) DO UPDATE SET version=EXCLUDED.version,active=EXCLUDED.active,
          beneficiary_id=COALESCE(user_activities.beneficiary_id,EXCLUDED.beneficiary_id),
          comment_id=COALESCE(user_activities.comment_id,EXCLUDED.comment_id),
          result_id=COALESCE(user_activities.result_id,EXCLUDED.result_id),event_id=EXCLUDED.event_id,
          occurred_at=CASE WHEN NOT user_activities.source_time_verified AND EXCLUDED.source_time_verified THEN EXCLUDED.occurred_at ELSE user_activities.occurred_at END,
          source_time_verified=user_activities.source_time_verified OR EXCLUDED.source_time_verified,
          correlation_id=EXCLUDED.correlation_id,updated_at=now()
        WHERE user_activities.version<EXCLUDED.version OR (user_activities.version=EXCLUDED.version AND (
          (user_activities.beneficiary_id IS NULL AND EXCLUDED.beneficiary_id IS NOT NULL) OR
          (user_activities.comment_id IS NULL AND EXCLUDED.comment_id IS NOT NULL) OR
          (user_activities.result_id IS NULL AND EXCLUDED.result_id IS NOT NULL) OR
          (NOT user_activities.source_time_verified AND EXCLUDED.source_time_verified))) RETURNING activity_key`,
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
          input.commentId ?? null,
          input.resultId ?? null,
          input.occurredAt ?? new Date().toISOString(),
          input.kind === 'VOTE_WIN' && input.occurredAt !== undefined,
        ],
      );
      if (changedActivities.length && input.kind === 'VOTE_WIN')
        await this.titles.markRankingDirty(m);
      await this.evaluatePost(
        m,
        input.postId,
        input.eventId,
        input.correlationId,
        input,
      );
    });
  }
  private async evaluatePost(
    m: import('typeorm').EntityManager,
    postId: string,
    eventId: string,
    correlationId: string,
    trigger?: ActivityInput,
  ) {
    const [post] = await m.query(
      'SELECT status FROM reward_posts WHERE post_id=$1',
      [postId],
    );
    const activities: ActivityRow[] = await m.query(
      'SELECT * FROM user_activities WHERE post_id=$1 ORDER BY beneficiary_id,activity_key',
      [postId],
    );
    // Sorted user locks avoid cycles when different posts reward the same users.
    const beneficiaries = await this.lockRewardUsers(m, [
      ...new Set(
        activities
          .flatMap((a) => [a.beneficiary_id, a.actor_id])
          .filter((id): id is string => id !== null),
      ),
    ]);
    for (const a of activities)
      await this.engine.evaluate(
        m,
        {
          ...a,
          event_id: eventId,
          correlation_id: correlationId,
        },
        post?.status ?? 'ACTIVE',
        a.comment_id !== null &&
          activities.some(
            (c) =>
              c.kind === 'COMMENT' &&
              c.comment_id === a.comment_id &&
              !c.active,
          ),
      );
    for (const id of beneficiaries)
      if (activities[0])
        await this.engine.syncBadges(m, {
          ...activities[0],
          beneficiary_id: id,
          event_id: eventId,
          correlation_id: correlationId,
        });
    // A reaction changes its actor and recipient, not every previous participant's
    // title metrics. Parent deletion is the case that invalidates all affected children.
    const affected =
      !trigger || (trigger.postStatus && trigger.postStatus !== 'ACTIVE')
        ? beneficiaries
        : trigger.kind === 'COMMENT' && !trigger.active
          ? activities
              .filter((a) => a.comment_id === trigger.commentId)
              .flatMap((a) => [a.actor_id, a.beneficiary_id])
          : [trigger.actorId, trigger.beneficiaryId];
    for (const id of new Set(affected))
      if (id !== null)
        await this.titles.syncUser(m, id, { eventId, correlationId });
  }
  private async lockRewardUsers(
    m: import('typeorm').EntityManager,
    ids: string[],
  ): Promise<string[]> {
    if (
      this.engine.policy.enabled &&
      this.engine.policy.badges.some((b) => b.rankTop !== undefined)
    ) {
      // Ranked titles can displace another user. Serialize that decision and refresh holders
      // in the same transaction so concurrent winners cannot retain the same top slot.
      await m.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('user-reward-ranking',0))",
      );
      const holders: Array<{ user_id: string }> = await m.query(
        `SELECT DISTINCT ub.user_id FROM user_badges ub JOIN badges b ON b.id=ub.badge_id
        WHERE ub.revoked_at IS NULL AND b.code=ANY($1::text[])`,
        [
          this.engine.policy.badges
            .filter((b) => b.rankTop !== undefined)
            .map((b) => b.code),
        ],
      );
      ids.push(...holders.map((h) => h.user_id));
    }
    const sorted = [...new Set(ids)].sort((a, b) =>
      BigInt(a) < BigInt(b) ? -1 : 1,
    );
    for (const id of sorted)
      await m.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [id]);
    return sorted;
  }
  // Explicit reconciliation keeps the same activity identities; it never deletes inbox receipts.
  async reconcileUser(userId: string, operationId: string): Promise<void> {
    if (!this.engine.policy.enabled && !this.titles.settings.enabled) return;
    const posts: Array<{ post_id: string }> = await this.db.query(
      'SELECT DISTINCT post_id FROM user_activities WHERE beneficiary_id=$1 ORDER BY post_id',
      [userId],
    );
    for (const { post_id } of posts)
      await this.db.transaction(async (m) => {
        await m.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
          post_id,
        ]);
        await this.titles.lock(m);
        await this.evaluatePost(
          m,
          post_id,
          `reward-reconcile:${operationId}`,
          `reward-reconcile:${operationId}`,
        );
      });
  }

  async refreshUserTitles(userId: string): Promise<void> {
    if (!this.engine.policy.enabled && !this.titles.settings.enabled) return;
    await this.db.transaction(async (m) => {
      await this.titles.lock(m);
      const users = await this.lockRewardUsers(m, [userId]);
      const [a] = await m.query(
        'SELECT * FROM user_activities WHERE actor_id=$1 OR beneficiary_id=$1 ORDER BY activity_key LIMIT 1',
        [userId],
      );
      if (a)
        for (const id of users)
          await this.engine.syncBadges(m, {
            ...a,
            beneficiary_id: id,
            event_id: `reward-title:${userId}:${Date.now()}`,
            correlation_id: 'reward-title-reconciliation',
          });
      await this.titles.syncUser(m, userId, {
        eventId: `reward-title:${userId}:${Date.now()}`,
        correlationId: 'reward-title-reconciliation',
      });
    });
  }
  async badgeHistory(userId: string, limit: number, before: string | null) {
    await this.summary(userId);
    const rows = await this.db.query(
      `SELECT h.id,h.badge_id AS "badgeId",b.code,b.name,h.action,h.policy_version AS "policyVersion",h.created_at AS "createdAt",
        h.region_code AS "regionCode",h.ranking_run_id AS "rankingRunId",h.reason
      FROM user_badge_history h JOIN badges b ON b.id=h.badge_id WHERE h.user_id=$1 AND ($2::bigint IS NULL OR h.id<$2)
      ORDER BY h.id DESC LIMIT $3`,
      [userId, before, limit + 1],
    );
    const items = rows.slice(0, limit).map((r: { createdAt: Date }) => ({
      ...r,
      createdAt: r.createdAt.toISOString(),
    }));
    return {
      items,
      nextCursor: rows.length > limit ? rows[limit - 1].id : null,
    };
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
      titles: await this.titles.progress(this.db.manager, userId),
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
