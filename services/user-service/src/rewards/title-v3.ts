import type { EntityManager } from 'typeorm';
import { TITLE_CODES } from './title-policy.js';
import type { TitleProgress } from './title.service.js';

export const TITLE_V3_POLICY = {
  version: 'wgo-titles-v3',
  participation: 10,
  agreeReceived: 10,
  representativeWins: 5,
  pickScore: 10,
  sequential: true,
  includeSelfAgree: true,
  aggregation: 'post-level-v1',
} as const;

export function titleV3Enabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const value = env.USER_TITLES_V3_ENABLED;
  if (
    value !== undefined &&
    value !== '' &&
    value !== 'true' &&
    value !== 'false'
  )
    throw new Error('USER_TITLES_V3_ENABLED must be true or false');
  return value === 'true';
}

export interface TitleV3Metrics {
  participation: string;
  agreeReceived: string;
  picks: string;
}

export function titleV3Stage(metrics: TitleV3Metrics, active = true): number {
  if (!active) return 0;
  if (BigInt(metrics.participation) < 10n) return 1;
  if (BigInt(metrics.agreeReceived) < 10n) return 2;
  return BigInt(metrics.picks) < 5n ? 3 : 4;
}

export class TitleV3 {
  constructor(readonly enabled = titleV3Enabled()) {}

  async metrics(m: EntityManager, userId: string): Promise<TitleV3Metrics> {
    // Match Post /me/level's per-kind filters, including retained child relations
    // after parent deletion. The v2 validity view deliberately has different rules.
    const [r] = await m.query(
      `WITH hidden_posts AS (
      SELECT target_id FROM title_hidden_content WHERE kind='POST'
    ), comments AS (
      SELECT a.* FROM user_activities a WHERE a.kind='COMMENT' AND a.actor_id=$1 AND a.active
      AND NOT EXISTS(SELECT 1 FROM title_hidden_content h WHERE h.kind='COMMENT' AND h.target_id=a.comment_id)
    ) SELECT
      ((SELECT count(*) FROM user_activities a LEFT JOIN reward_posts p ON p.post_id=a.post_id
        WHERE a.kind='POST' AND a.actor_id=$1 AND (a.active OR p.status='EXPIRED')
        AND COALESCE(p.status,'ACTIVE')<>'DELETED' AND a.post_id NOT IN (SELECT target_id FROM hidden_posts))
       +(SELECT count(*) FROM comments WHERE actor_id=$1)
       +(SELECT count(*) FROM user_activities WHERE actor_id=$1 AND active AND kind IN ('POST_REACTION','COMMENT_REACTION'))
       +(SELECT count(*) FROM title_vote_selections WHERE user_id=$1 AND comment_id IS NOT NULL))::text AS participation,
      (SELECT count(*)::text FROM user_activities a JOIN comments c ON c.comment_id=a.comment_id AND c.post_id=a.post_id
        WHERE a.kind='COMMENT_REACTION' AND a.active AND a.reaction_type='AGREE' AND c.actor_id=$1 AND a.beneficiary_id=$1) AS "agreeReceived",
      (SELECT count(DISTINCT a.result_id)::text FROM user_activities a
        JOIN comments c ON c.comment_id=a.comment_id AND c.post_id=a.post_id AND c.actor_id=$1
        JOIN reward_posts p ON p.post_id=a.post_id AND p.status<>'DELETED'
        WHERE a.kind='VOTE_WIN' AND a.active AND a.beneficiary_id=$1
        AND a.post_id NOT IN (SELECT target_id FROM hidden_posts)) AS picks`,
      [userId],
    );
    return r;
  }

  async compare(m: EntityManager, userId: string) {
    const [user] = await m.query('SELECT status FROM users WHERE id=$1', [
      userId,
    ]);
    if (!user) throw new Error('User not found');
    const metrics = await this.metrics(m, userId);
    const stage = titleV3Stage(metrics, user.status === 'ACTIVE');
    const held: Array<{ code: string }> = await m.query(
      `SELECT b.code FROM user_badges u JOIN badges b ON b.id=u.badge_id
      WHERE u.user_id=$1 AND u.revoked_at IS NULL AND b.active AND b.code=ANY($2::text[])`,
      [userId, TITLE_CODES],
    );
    return {
      policyVersion: TITLE_V3_POLICY.version,
      enabled: this.enabled,
      metrics,
      stage,
      currentCodes: held.map((b) => b.code),
      targetCodes: TITLE_CODES.slice(0, stage),
      inputCoverage:
        'Projection only: reconcile pre-rollout votes and missing Post facts before activation',
    };
  }

  async sync(
    m: EntityManager,
    userId: string,
    change: (code: string, qualified: boolean) => Promise<void>,
  ) {
    if (!this.enabled) return;
    const [user] = await m.query(
      'SELECT status FROM users WHERE id=$1 FOR UPDATE',
      [userId],
    );
    if (!user) return;
    await m.query(
      'INSERT INTO reward_policies(version,definition) VALUES($1,$2) ON CONFLICT DO NOTHING',
      [TITLE_V3_POLICY.version, JSON.stringify(TITLE_V3_POLICY)],
    );
    const [policy] = await m.query(
      'SELECT definition=$2::jsonb AS matches FROM reward_policies WHERE version=$1',
      [TITLE_V3_POLICY.version, JSON.stringify(TITLE_V3_POLICY)],
    );
    if (!policy.matches)
      throw new Error('WGO title v3 policy version mismatch');
    const metrics = await this.metrics(m, userId);
    const stage = titleV3Stage(metrics, user.status === 'ACTIVE');
    for (let i = 0; i < TITLE_CODES.length; i++)
      await change(TITLE_CODES[i]!, i < stage);
    const held: Array<{ code: string }> = await m.query(
      `SELECT b.code FROM user_badges u JOIN badges b ON b.id=u.badge_id
      WHERE u.user_id=$1 AND u.revoked_at IS NULL AND b.active AND b.code=ANY($2::text[])`,
      [userId, TITLE_CODES],
    );
    const current = Math.max(
      0,
      ...held.map(
        (b) => TITLE_CODES.indexOf(b.code as (typeof TITLE_CODES)[number]) + 1,
      ),
    );
    const achievements = Object.fromEntries(
      held.map((b) => [b.code, new Date().toISOString()]),
    );
    await m.query(
      `INSERT INTO user_title_v3_progress(user_id,participation,agree_received,picks,current_stage,highest_stage,achieved_stages)
      VALUES($1,$2,$3,$4,$5,$5,$6) ON CONFLICT(user_id) DO UPDATE SET participation=EXCLUDED.participation,
      agree_received=EXCLUDED.agree_received,picks=EXCLUDED.picks,current_stage=EXCLUDED.current_stage,
      highest_stage=GREATEST(user_title_v3_progress.highest_stage,EXCLUDED.highest_stage),
      achieved_stages=EXCLUDED.achieved_stages||user_title_v3_progress.achieved_stages,updated_at=now()`,
      [
        userId,
        metrics.participation,
        metrics.agreeReceived,
        metrics.picks,
        current,
        JSON.stringify(achievements),
      ],
    );
  }

  async progress(
    m: EntityManager,
    userId: string,
  ): Promise<Omit<TitleProgress, 'regionalRanking'>> {
    const [p] = await m.query(
      `SELECT p.*,u.status FROM users u LEFT JOIN user_title_v3_progress p ON p.user_id=u.id WHERE u.id=$1`,
      [userId],
    );
    const stats = {
      participation: String(p?.participation ?? 0),
      agreeReceived: String(p?.agree_received ?? 0),
      picks: String(p?.picks ?? 0),
    };
    const currentStage =
      p?.status === 'ACTIVE' ? Number(p?.current_stage ?? 0) : 0;
    const qualifiedStage = titleV3Stage(stats, p?.status === 'ACTIVE');
    const values = [
      '1',
      stats.participation,
      stats.agreeReceived,
      String(BigInt(stats.picks) * 10n),
    ];
    const required = ['1', '10', '10', '50'];
    const conditions = [
      '가입 즉시',
      '게시판 참여 10회',
      '내 댓글이 받은 AGREE 누적 10개',
      '대표 의견 선정 5회 (50점)',
    ];
    const names = ['소식통', '리포터', '특파원', '천리안'];
    const stages = TITLE_CODES.map((code, i) => ({
      stage: i + 1,
      code,
      name: names[i]!,
      condition: conditions[i]!,
      progress: values[i]!,
      required: required[i]!,
      remaining: String(
        BigInt(values[i]!) >= BigInt(required[i]!)
          ? 0n
          : BigInt(required[i]!) - BigInt(values[i]!),
      ),
      qualified: i < qualifiedStage,
      achieved: !!p?.achieved_stages?.[code],
      achievedAt: p?.achieved_stages?.[code] ?? null,
    }));
    const next = stages.find((s) => s.stage > currentStage);
    return {
      enabled: this.enabled,
      ready: p?.current_stage !== null && p?.current_stage !== undefined,
      policyVersion: TITLE_V3_POLICY.version,
      currentStage,
      highestAchievedStage: Number(p?.highest_stage ?? 0),
      stats,
      stages,
      nextTitle: next ? { code: next.code, remaining: next.remaining } : null,
    };
  }
}
