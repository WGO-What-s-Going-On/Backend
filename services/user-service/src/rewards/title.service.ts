import { Inject, Injectable, Optional } from '@nestjs/common';
import type { EntityManager } from 'typeorm';
import { BADGE_CATALOG } from './badge-catalog.js';
import {
  ConflictingRewardEvent,
  InvalidRewardEvent,
  parseRegionSnapshot,
  type PostRegionSnapshot,
} from './post-event.js';
import { emitRewardEvent, type RewardEventContext } from './reward-events.js';
import {
  loadTitleSettings,
  rankingWindow,
  TITLE_CODES,
  TITLE_POLICY,
  TITLE_SETTINGS,
  type TitleSettings,
} from './title-policy.js';

export interface TitleMetrics {
  participation: string;
  reporter_comments: string;
  representative_wins: string;
}
export interface TitleProgress {
  enabled: boolean;
  policyVersion: string;
  currentStage: number;
  highestAchievedStage: number;
  stages: Array<{
    stage: number;
    code: string;
    name: string;
    condition: string;
    progress: string;
    required: string | null;
    remaining: string | null;
    qualified: boolean;
    achieved: boolean;
    achievedAt: string | null;
  }>;
  nextTitle: { code: string; remaining: string | null } | null;
  regionalRanking: {
    enabled: boolean;
    ready: boolean;
    status: string;
    missingRegionResults: string;
    unverifiedTimeResults: string;
    timeZone: string;
    nextUpdateAt: string;
    regions: RegionalProgress[];
  };
}
export interface RegionalProgress {
  regionCode: string;
  regionName: string;
  rankingDate: string | null;
  score: string;
  rank: string | null;
  competitors: string;
  slots: string;
  cutoffScore: string | null;
  additionalSelectionsForGuaranteedEntry: string | null;
  selected: boolean;
  eligible: boolean;
  entryPossible: boolean;
  upToDate: boolean;
  runId: string | null;
}

@Injectable()
export class TitleService {
  readonly settings: TitleSettings;
  constructor(@Optional() @Inject(TITLE_SETTINGS) settings?: TitleSettings) {
    this.settings = settings ?? loadTitleSettings();
  }
  async lock(m: EntityManager) {
    // Inputs, title transitions and ranking snapshots share this fence. No network I/O is done while held.
    if (this.settings.enabled)
      await m.query(
        "SELECT pg_advisory_xact_lock(hashtextextended('wgo-title-policy',0))",
      );
  }
  async ensurePolicy(m: EntityManager) {
    await m.query(
      'INSERT INTO reward_policies(version,definition) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [TITLE_POLICY.version, JSON.stringify(TITLE_POLICY)],
    );
    const [r] = await m.query(
      'SELECT definition=$2::jsonb AS matches FROM reward_policies WHERE version=$1',
      [TITLE_POLICY.version, JSON.stringify(TITLE_POLICY)],
    );
    if (!r.matches) throw new Error('WGO title policy version mismatch');
  }
  async markRankingDirty(m: EntityManager) {
    await m.query(
      'UPDATE regional_ranking_state SET input_revision=input_revision+1 WHERE singleton=true',
    );
  }
  async metrics(m: EntityManager, userId: string): Promise<TitleMetrics> {
    const [r] = await m.query(
      `SELECT
      (SELECT count(DISTINCT CASE WHEN a.kind='POST_REACTION' THEN 'post-reaction:'||a.post_id
        WHEN a.kind='COMMENT_REACTION' THEN 'comment-reaction:'||a.comment_id ELSE a.activity_key END)::text
       FROM reward_title_valid_activities a WHERE a.actor_id=$1 AND a.kind IN ('POST','COMMENT','POST_REACTION','COMMENT_REACTION')) AS participation,
      (SELECT count(*)::text FROM (SELECT a.comment_id FROM reward_title_valid_activities a
        JOIN reward_title_valid_activities c ON c.kind='COMMENT' AND c.comment_id=a.comment_id AND c.post_id=a.post_id AND c.actor_id=$1
        WHERE a.kind='COMMENT_REACTION' AND a.reaction_type='AGREE' AND a.beneficiary_id=$1 AND a.actor_id<>$1
        GROUP BY a.comment_id HAVING count(DISTINCT a.actor_id)>=$2) qualified) AS reporter_comments,
      (SELECT count(DISTINCT result_id)::text FROM reward_title_valid_activities WHERE kind='VOTE_WIN' AND beneficiary_id=$1) AS representative_wins`,
      [userId, TITLE_POLICY.agreesPerComment],
    );
    return r;
  }
  async syncUser(
    m: EntityManager,
    userId: string,
    context: RewardEventContext,
  ) {
    if (!this.settings.enabled) return;
    const [user] = await m.query(
      'SELECT status FROM users WHERE id=$1 FOR UPDATE',
      [userId],
    );
    if (!user) return;
    await this.ensurePolicy(m);
    const counts = await this.metrics(m, userId);
    const [before] = await m.query(
      'SELECT * FROM user_title_progress WHERE user_id=$1',
      [userId],
    );
    const conditions = [
      BigInt(counts.participation) >= BigInt(TITLE_POLICY.participation),
      BigInt(counts.reporter_comments) >= BigInt(TITLE_POLICY.reporterComments),
      BigInt(counts.representative_wins) >=
        BigInt(TITLE_POLICY.representativeWins),
    ];
    const achievements: Record<string, string> = {};
    let highest = 0;
    for (let i = 0; i < 3; i++)
      if (conditions[i] && user.status === 'ACTIVE') {
        highest = i + 1;
        if (!before?.achieved_stages[TITLE_CODES[i]!])
          achievements[TITLE_CODES[i]!] = new Date().toISOString();
      }
    await m.query(
      `INSERT INTO user_title_progress(user_id,participation,reporter_comments,representative_wins,account_status,highest_stage,achieved_stages)
      VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(user_id) DO UPDATE SET participation=EXCLUDED.participation,
      reporter_comments=EXCLUDED.reporter_comments,representative_wins=EXCLUDED.representative_wins,account_status=EXCLUDED.account_status,
      highest_stage=GREATEST(user_title_progress.highest_stage,EXCLUDED.highest_stage),achieved_stages=user_title_progress.achieved_stages||EXCLUDED.achieved_stages,updated_at=now()`,
      [
        userId,
        counts.participation,
        counts.reporter_comments,
        counts.representative_wins,
        user.status,
        highest,
        JSON.stringify(achievements),
      ],
    );
    if (
      BigInt(before?.representative_wins ?? 0) !==
        BigInt(counts.representative_wins) ||
      (before && before.account_status !== user.status)
    )
      await this.markRankingDirty(m);
    for (let i = 0; i < 3; i++)
      await this.changeBadge(
        m,
        userId,
        TITLE_CODES[i]!,
        conditions[i] === true && user.status === 'ACTIVE',
        context,
        'VALID_ACTIVITY_CONDITIONS',
      );
    // The highest stage survives rank loss; regional grants cannot survive loss of correspondent eligibility.
    if (user.status !== 'ACTIVE' || !conditions[2]) {
      const held: Array<{ region_code: string; run_id: string }> =
        await m.query(
          'SELECT region_code,run_id FROM user_regional_badges WHERE user_id=$1 AND revoked_at IS NULL ORDER BY region_code',
          [userId],
        );
      for (const h of held)
        await this.changeRegional(
          m,
          userId,
          h.region_code,
          h.run_id,
          false,
          context,
          {
            reason:
              user.status !== 'ACTIVE'
                ? 'ACCOUNT_INACTIVE'
                : 'CORRESPONDENT_REQUIRED',
          },
        );
    }
    await this.syncRegionalSummary(m, userId, context);
  }
  private async badge(m: EntityManager, code: string) {
    const [badge] = await m.query(
      'SELECT id,code,name,active FROM badges WHERE code=$1',
      [code],
    );
    if (!badge) throw new Error(`WGO title catalog is missing: ${code}`);
    return badge as { id: string; code: string; name: string; active: boolean };
  }
  async changeBadge(
    m: EntityManager,
    userId: string,
    code: string,
    qualifies: boolean,
    context: RewardEventContext,
    reason: string,
  ) {
    const b = await this.badge(m, code);
    if (!b.active) qualifies = false;
    const [old] = await m.query(
      'SELECT revoked_at FROM user_badges WHERE user_id=$1 AND badge_id=$2',
      [userId, b.id],
    );
    if (qualifies && (!old || old.revoked_at !== null)) {
      await m.query(
        `INSERT INTO user_badges(user_id,badge_id,granted_at,revoked_at) VALUES($1,$2,now(),null)
        ON CONFLICT(user_id,badge_id) DO UPDATE SET granted_at=now(),revoked_at=null`,
        [userId, b.id],
      );
      await this.recordBadgeChange(m, userId, b, 'GRANTED', context, {
        reason,
      });
    } else if (!qualifies && old?.revoked_at === null) {
      await m.query(
        'UPDATE user_badges SET revoked_at=now() WHERE user_id=$1 AND badge_id=$2',
        [userId, b.id],
      );
      await this.recordBadgeChange(m, userId, b, 'REVOKED', context, {
        reason,
      });
    }
  }
  private async recordBadgeChange(
    m: EntityManager,
    userId: string,
    b: { id: string; code: string; name: string },
    action: 'GRANTED' | 'REVOKED',
    context: RewardEventContext,
    details: Record<string, unknown>,
  ) {
    await m.query(
      `INSERT INTO user_badge_history(user_id,badge_id,action,policy_version,region_code,ranking_run_id,reason) VALUES($1,$2,$3,$4,$5,$6,$7)`,
      [
        userId,
        b.id,
        action,
        TITLE_POLICY.version,
        details.regionCode ?? null,
        details.rankingRunId ?? null,
        details.reason ?? null,
      ],
    );
    await emitRewardEvent(m, userId, context, `USER_BADGE_${action}`, {
      badgeId: b.id,
      policyVersion: TITLE_POLICY.version,
      badgeCode: b.code,
      badgeName: b.name,
      stage: TITLE_CODES.indexOf(b.code as (typeof TITLE_CODES)[number]) + 1,
      ...details,
    });
  }
  async changeRegional(
    m: EntityManager,
    userId: string,
    regionCode: string,
    runId: string,
    selected: boolean,
    context: RewardEventContext,
    details: Record<string, unknown>,
  ) {
    const b = await this.badge(m, 'CLAIRVOYANT');
    if (!b.active) selected = false;
    const [old] = await m.query(
      'SELECT revoked_at FROM user_regional_badges WHERE user_id=$1 AND badge_id=$2 AND region_code=$3',
      [userId, b.id, regionCode],
    );
    if (selected && (!old || old.revoked_at !== null)) {
      await m.query(
        `INSERT INTO user_regional_badges(user_id,badge_id,region_code,run_id) VALUES($1,$2,$3,$4)
        ON CONFLICT(user_id,badge_id,region_code) DO UPDATE SET granted_at=now(),revoked_at=null,run_id=EXCLUDED.run_id`,
        [userId, b.id, regionCode, runId],
      );
      await m.query(
        `UPDATE user_title_progress SET highest_stage=4,
        achieved_stages=CASE WHEN achieved_stages?'CLAIRVOYANT' THEN achieved_stages ELSE achieved_stages||jsonb_build_object('CLAIRVOYANT',now()) END WHERE user_id=$1`,
        [userId],
      );
      await this.recordBadgeChange(m, userId, b, 'GRANTED', context, {
        ...details,
        regionCode,
        rankingRunId: runId,
      });
    } else if (!selected && old?.revoked_at === null) {
      await m.query(
        'UPDATE user_regional_badges SET revoked_at=now(),run_id=$4 WHERE user_id=$1 AND badge_id=$2 AND region_code=$3',
        [userId, b.id, regionCode, runId],
      );
      await this.recordBadgeChange(m, userId, b, 'REVOKED', context, {
        ...details,
        regionCode,
        rankingRunId: runId,
      });
    } else if (selected)
      await m.query(
        'UPDATE user_regional_badges SET run_id=$4 WHERE user_id=$1 AND badge_id=$2 AND region_code=$3',
        [userId, b.id, regionCode, runId],
      );
    await this.syncRegionalSummary(m, userId, context);
  }
  private async syncRegionalSummary(
    m: EntityManager,
    userId: string,
    context: RewardEventContext,
  ) {
    const b = await this.badge(m, 'CLAIRVOYANT');
    const [r] = await m.query(
      'SELECT count(*) FILTER(WHERE revoked_at IS NULL)::text AS active,count(*)::text AS total FROM user_regional_badges WHERE user_id=$1 AND badge_id=$2',
      [userId, b.id],
    );
    if (BigInt(r.active) > 0n)
      await m.query(
        `INSERT INTO user_badges(user_id,badge_id,granted_at,revoked_at) VALUES($1,$2,now(),null)
      ON CONFLICT(user_id,badge_id) DO UPDATE SET revoked_at=null`,
        [userId, b.id],
      );
    else if (r.total === '0')
      await this.changeBadge(
        m,
        userId,
        'CLAIRVOYANT',
        false,
        context,
        'NO_VERIFIED_REGION',
      );
    else
      await m.query(
        'UPDATE user_badges SET revoked_at=COALESCE(revoked_at,now()) WHERE user_id=$1 AND badge_id=$2',
        [userId, b.id],
      );
  }
  async recordRegion(
    m: EntityManager,
    postId: string,
    version: number,
    region: PostRegionSnapshot | null,
    eventId: string,
  ) {
    if (this.settings.regionContract !== 'post-region-v1')
      throw new Error('Post region contract is unavailable');
    if (!Number.isSafeInteger(version) || version < 1)
      throw new InvalidRewardEvent('Invalid post region revision');
    if (region !== null) {
      parseRegionSnapshot(region);
      if (region.version !== version)
        throw new ConflictingRewardEvent('Region revision mismatch');
    }
    const [old] = await m.query(
      'SELECT * FROM reward_post_regions WHERE post_id=$1',
      [postId],
    );
    if (old && BigInt(old.version) > BigInt(version)) return;
    if (old && BigInt(old.version) === BigInt(version)) {
      if (
        old.region_code !== (region?.code ?? null) ||
        old.region_name !== (region?.name ?? null)
      )
        throw new ConflictingRewardEvent('Conflicting post region revision');
      return;
    }
    await m.query(
      'INSERT INTO reward_post_region_history(post_id,version,region_code,region_name,event_id) VALUES($1,$2,$3,$4,$5)',
      [postId, version, region?.code ?? null, region?.name ?? null, eventId],
    );
    await m.query(
      `INSERT INTO reward_post_regions(post_id,version,region_code,region_name,event_id) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(post_id) DO UPDATE SET version=EXCLUDED.version,region_code=EXCLUDED.region_code,region_name=EXCLUDED.region_name,event_id=EXCLUDED.event_id,updated_at=now()`,
      [postId, version, region?.code ?? null, region?.name ?? null, eventId],
    );
    await this.markRankingDirty(m);
  }
  async completeness(m: EntityManager, start: Date, end: Date) {
    const [r] = await m.query(
      `SELECT count(*) FILTER(WHERE r.post_id IS NULL)::text AS missing,
      count(*) FILTER(WHERE NOT a.source_time_verified)::text AS unverified
      FROM reward_title_valid_activities a JOIN users u ON u.id=a.beneficiary_id AND u.status='ACTIVE'
      JOIN user_title_progress t ON t.user_id=u.id AND t.representative_wins>=$3
      LEFT JOIN reward_post_regions r ON r.post_id=a.post_id
      WHERE a.kind='VOTE_WIN' AND (NOT a.source_time_verified OR (a.occurred_at>=$1 AND a.occurred_at<$2))
      AND (r.post_id IS NULL OR r.region_code IS NOT NULL)`,
      [start, end, TITLE_POLICY.representativeWins],
    );
    return r as { missing: string; unverified: string };
  }
  async progress(
    m: EntityManager,
    userId: string,
    now = new Date(),
  ): Promise<TitleProgress> {
    const [p] = await m.query(
      'SELECT t.*,u.status FROM users u LEFT JOIN user_title_progress t ON t.user_id=u.id WHERE u.id=$1',
      [userId],
    );
    const held: Array<{ code: string }> = await m.query(
      `SELECT b.code FROM user_badges ub JOIN badges b ON b.id=ub.badge_id WHERE ub.user_id=$1 AND ub.revoked_at IS NULL AND b.active AND b.code=ANY($2::text[])`,
      [userId, TITLE_CODES],
    );
    const window = rankingWindow(now),
      completeness = await this.completeness(m, window.start, window.end);
    const ready =
      this.settings.enabled &&
      this.settings.regionalRankingEnabled &&
      this.settings.regionContract === 'post-region-v1' &&
      completeness.missing === '0' &&
      completeness.unverified === '0';
    const regions: RegionalProgress[] = await m.query(
      `WITH contributions AS (
      SELECT r.region_code,max(r.region_name) AS region_name,count(DISTINCT a.result_id)::text AS score
      FROM reward_title_valid_activities a JOIN reward_post_regions r ON r.post_id=a.post_id
      WHERE a.kind='VOTE_WIN' AND a.beneficiary_id=$1 AND a.source_time_verified AND r.region_code IS NOT NULL
      AND a.occurred_at>=$2 AND a.occurred_at<$3 GROUP BY r.region_code)
      SELECT c.region_code AS "regionCode",c.region_name AS "regionName",run.ranking_date::text AS "rankingDate",COALESCE(e.score::text,c.score) AS score,
        e.rank,COALESCE(run.competitors,0)::text AS competitors,COALESCE(run.slots,0)::text AS slots,
        COALESCE(g.revoked_at IS NULL AND g.user_id IS NOT NULL,false) AS selected,
        cutoff.score AS "cutoffScore",
        CASE WHEN NOT $4::boolean OR cutoff.score IS NULL THEN NULL
          WHEN COALESCE(g.revoked_at IS NULL AND g.user_id IS NOT NULL,false) THEN '0'
          ELSE GREATEST(cutoff.score+1-COALESCE(e.score,c.score::bigint),0)::text END AS "additionalSelectionsForGuaranteedEntry",
        ($4::boolean) AS eligible,($4::boolean AND $6::boolean AND COALESCE(run.slots,0)>0 AND run.suppressed_reason IS NULL
          AND run.ranking_date=$5::date AND run.input_revision=state.input_revision) AS "entryPossible",
        COALESCE(run.ranking_date=$5::date AND run.input_revision=state.input_revision,false) AS "upToDate",run.id AS "runId"
      FROM contributions c LEFT JOIN regional_ranking_heads h ON h.region_code=c.region_code
      LEFT JOIN regional_ranking_runs run ON run.id=h.run_id LEFT JOIN regional_ranking_entries e ON e.run_id=run.id AND e.user_id=$1
      LEFT JOIN user_regional_badges g ON g.user_id=$1 AND g.region_code=c.region_code
      LEFT JOIN regional_ranking_entries cutoff ON cutoff.run_id=run.id AND cutoff.rank=run.slots
      CROSS JOIN regional_ranking_state state
      ORDER BY c.region_code`,
      [
        userId,
        window.start,
        window.end,
        p?.status === 'ACTIVE' && BigInt(p?.representative_wins ?? 0) >= 5n,
        window.date,
        ready,
      ],
    );
    const progress = [
      String(p?.participation ?? 0),
      String(p?.reporter_comments ?? 0),
      String(p?.representative_wins ?? 0),
      String(regions.filter((r) => r.selected).length),
    ];
    const required = ['10', '10', '5', null];
    const conditions = [
      '유효 참여 10회 (입장 이벤트 제외)',
      '서로 다른 댓글 10개가 각각 AGREE 10명 이상',
      '서로 다른 대표 의견 선정 결과 5건',
      '행정동별 최근 30일 유효 특파원 10명 이상 중 상위 floor(N/10)',
    ];
    const stages = TITLE_CODES.map((code, i) => ({
      stage: i + 1,
      code,
      name: BADGE_CATALOG[i]!.name,
      condition: conditions[i]!,
      progress: progress[i]!,
      required: required[i] ?? null,
      remaining:
        required[i] === null
          ? null
          : String(
              BigInt(required[i]!) > BigInt(progress[i]!)
                ? BigInt(required[i]!) - BigInt(progress[i]!)
                : 0n,
            ),
      qualified:
        this.settings.enabled &&
        p?.status === 'ACTIVE' &&
        (i === 3
          ? regions.some((r) => r.selected)
          : BigInt(progress[i]!) >= BigInt(required[i]!)),
      achieved: !!p?.achieved_stages?.[code],
      achievedAt: p?.achieved_stages?.[code] ?? null,
    }));
    const currentStage = Math.max(
      0,
      ...held.map(
        (b) => TITLE_CODES.indexOf(b.code as (typeof TITLE_CODES)[number]) + 1,
      ),
    );
    const next = stages.find((s) => s.stage > currentStage);
    return {
      enabled: this.settings.enabled,
      policyVersion: TITLE_POLICY.version,
      currentStage,
      highestAchievedStage: p?.highest_stage ?? 0,
      stages,
      nextTitle: next ? { code: next.code, remaining: next.remaining } : null,
      regionalRanking: {
        enabled: this.settings.regionalRankingEnabled,
        ready,
        status:
          !this.settings.enabled || !this.settings.regionalRankingEnabled
            ? 'DISABLED'
            : this.settings.regionContract === 'none'
              ? 'CONTRACT_UNAVAILABLE'
              : ready
                ? 'READY'
                : 'INCOMPLETE_SOURCE_DATA',
        missingRegionResults: completeness.missing,
        unverifiedTimeResults: completeness.unverified,
        timeZone: TITLE_POLICY.timeZone,
        nextUpdateAt: window.next.toISOString(),
        regions,
      },
    };
  }
}
