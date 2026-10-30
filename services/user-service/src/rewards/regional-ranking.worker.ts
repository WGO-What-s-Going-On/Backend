import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnModuleDestroy,
} from '@nestjs/common';
import { InjectDataSource } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { randomUUID } from 'node:crypto';
import { TitleService } from './title.service.js';
import { rankingWindow, TITLE_POLICY } from './title-policy.js';

@Injectable()
export class RegionalRankingWorker
  implements OnApplicationBootstrap, OnModuleDestroy
{
  private readonly logger = new Logger(RegionalRankingWorker.name);
  private timer?: NodeJS.Timeout;
  private running: Promise<void> | undefined;
  private stopping = false;
  constructor(
    @InjectDataSource() private readonly db: DataSource,
    private readonly titles: TitleService,
  ) {}
  onApplicationBootstrap() {
    if (!this.ready) return;
    // The durable date/revision head is the schedule checkpoint, not an in-memory midnight timer.
    this.timer = setInterval(() => void this.run(), 1000);
    this.timer.unref();
    void this.run();
  }
  get ready() {
    return (
      this.titles.settings.enabled &&
      this.titles.settings.regionalRankingEnabled &&
      this.titles.settings.regionContract === 'post-region-v1'
    );
  }
  run(now = new Date()): Promise<void> {
    if (!this.ready || this.stopping) return Promise.resolve();
    this.running ??= this.batch(now)
      .catch(() => {
        this.logger.warn(
          'Regional title ranking failed; durable checkpoints will be retried',
        );
      })
      .finally(() => {
        this.running = undefined;
      });
    return this.running;
  }
  private async batch(now: Date) {
    const { date } = rankingWindow(now);
    // Work is bounded by region count. Unfinished dates and delayed input revisions remain eligible after restart.
    const regions: Array<{ region_code: string }> = await this.db.query(
      `SELECT regions.region_code FROM (
      SELECT region_code FROM reward_post_regions WHERE region_code IS NOT NULL
      UNION SELECT region_code FROM regional_ranking_heads
      UNION SELECT region_code FROM user_regional_badges WHERE revoked_at IS NULL) regions
      CROSS JOIN regional_ranking_state state LEFT JOIN regional_ranking_heads h ON h.region_code=regions.region_code
      LEFT JOIN regional_ranking_runs r ON r.id=h.run_id
      WHERE r.id IS NULL OR r.ranking_date<$1 OR r.input_revision<state.input_revision
      ORDER BY r.created_at ASC NULLS FIRST,regions.region_code LIMIT 20`,
      [date],
    );
    for (const r of regions) {
      if (this.stopping) break;
      await this.recompute(r.region_code, now);
    }
  }
  async recompute(
    regionCode: string,
    now = new Date(),
  ): Promise<string | null> {
    if (!/^[0-9]{10}$/.test(regionCode))
      throw new Error('A 10-digit administrative district code is required');
    if (!this.ready) return null;
    const window = rankingWindow(now);
    return this.db.transaction(async (m) => {
      await this.titles.lock(m);
      const [{ locked }] = await m.query(
        "SELECT pg_try_advisory_xact_lock(hashtextextended('wgo-region:'||$1,0)) AS locked",
        [regionCode],
      );
      if (!locked) return null;
      const [{ input_revision: revision }] = await m.query(
        'SELECT input_revision FROM regional_ranking_state WHERE singleton=true',
      );
      const [head] = await m.query(
        `SELECT r.* FROM regional_ranking_heads h JOIN regional_ranking_runs r ON r.id=h.run_id WHERE h.region_code=$1`,
        [regionCode],
      );
      if (head && new Date(head.window_end).getTime() > window.end.getTime())
        throw new Error(
          'Historical ranking cannot overwrite the current title snapshot',
        );
      if (
        head &&
        new Date(head.window_end).getTime() === window.end.getTime() &&
        head.input_revision === revision
      )
        return head.id as string;
      await this.titles.ensurePolicy(m);
      const affected: Array<{ id: string }> = await m.query(
        `SELECT DISTINCT u.id FROM users u WHERE u.id IN (
        SELECT a.beneficiary_id FROM user_activities a JOIN reward_post_regions r ON r.post_id=a.post_id
          WHERE a.kind='VOTE_WIN' AND r.region_code=$1 AND a.source_time_verified AND a.occurred_at>=$2 AND a.occurred_at<$3
        UNION SELECT user_id FROM user_regional_badges WHERE region_code=$1 AND revoked_at IS NULL) ORDER BY u.id`,
        [regionCode, window.start, window.end],
      );
      for (const u of affected)
        await m.query('SELECT id FROM users WHERE id=$1 FOR UPDATE', [u.id]);
      const incomplete = await this.titles.completeness(
        m,
        window.start,
        window.end,
      );
      const complete =
        incomplete.missing === '0' && incomplete.unverified === '0';
      const runId = randomUUID();
      const [counts] = await m.query(
        `SELECT count(*)::text AS competitors FROM (
        SELECT a.beneficiary_id FROM reward_title_valid_activities a
        JOIN reward_post_regions r ON r.post_id=a.post_id AND r.region_code=$1
        JOIN users u ON u.id=a.beneficiary_id AND u.status='ACTIVE'
        JOIN user_title_progress p ON p.user_id=u.id AND p.representative_wins>=$4
        WHERE a.kind='VOTE_WIN' AND a.source_time_verified AND a.occurred_at>=$2 AND a.occurred_at<$3
        GROUP BY a.beneficiary_id) candidates`,
        [regionCode, window.start, window.end, TITLE_POLICY.representativeWins],
      );
      const competitors = BigInt(counts.competitors),
        slots = complete && competitors >= 10n ? competitors / 10n : 0n;
      await m.query(
        `INSERT INTO regional_ranking_runs(id,region_code,ranking_date,window_start,window_end,input_revision,policy_version,competitors,slots,suppressed_reason)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
        [
          runId,
          regionCode,
          window.date,
          window.start,
          window.end,
          revision,
          TITLE_POLICY.version,
          competitors.toString(),
          slots.toString(),
          complete ? null : 'INCOMPLETE_SOURCE_DATA',
        ],
      );
      await m.query(
        `WITH contributions AS (
        SELECT a.beneficiary_id AS user_id,count(DISTINCT a.result_id)::bigint AS score,max(a.occurred_at) AS last_selected_at,
          max(p.representative_wins) AS qualifying_wins,
          jsonb_agg(jsonb_build_object('resultId',a.result_id,'postId',a.post_id,'commentId',a.comment_id,'closedAt',a.occurred_at,
            'regionCode',r.region_code,'regionName',r.region_name,'regionVersion',r.version) ORDER BY a.result_id) AS evidence
        FROM reward_title_valid_activities a JOIN reward_post_regions r ON r.post_id=a.post_id AND r.region_code=$1
        JOIN users u ON u.id=a.beneficiary_id AND u.status='ACTIVE'
        JOIN user_title_progress p ON p.user_id=u.id AND p.representative_wins>=$4
        WHERE a.kind='VOTE_WIN' AND a.source_time_verified AND a.occurred_at>=$2 AND a.occurred_at<$3 GROUP BY a.beneficiary_id
      ),ranked AS (SELECT *,row_number() OVER(ORDER BY score DESC,last_selected_at ASC,user_id ASC) AS rank FROM contributions)
      INSERT INTO regional_ranking_entries(run_id,user_id,score,rank,selected,last_selected_at,qualifying_wins,evidence)
        SELECT $5,user_id,score,rank,rank<=$6,last_selected_at,qualifying_wins,evidence FROM ranked`,
        [
          regionCode,
          window.start,
          window.end,
          TITLE_POLICY.representativeWins,
          runId,
          slots.toString(),
        ],
      );
      const changes: Array<{
        user_id: string;
        selected: boolean;
        rank: string | null;
        score: string | null;
      }> = await m.query(
        `SELECT candidates.user_id,
        COALESCE(e.selected,false) AS selected,e.rank,e.score FROM (
          SELECT user_id FROM regional_ranking_entries WHERE run_id=$1
          UNION SELECT user_id FROM user_regional_badges WHERE region_code=$2 AND revoked_at IS NULL) candidates
        LEFT JOIN regional_ranking_entries e ON e.run_id=$1 AND e.user_id=candidates.user_id ORDER BY candidates.user_id`,
        [runId, regionCode],
      );
      const [region] = await m.query(
        'SELECT region_name FROM reward_post_regions WHERE region_code=$1 ORDER BY post_id LIMIT 1',
        [regionCode],
      );
      for (const c of changes)
        await this.titles.changeRegional(
          m,
          c.user_id,
          regionCode,
          runId,
          c.selected,
          {
            eventId: `regional-ranking:${runId}`,
            correlationId: `regional-ranking:${window.date}:${regionCode}`,
          },
          {
            reason: complete
              ? 'REGIONAL_TOP_TEN_PERCENT'
              : 'INCOMPLETE_SOURCE_DATA',
            regionName: region?.region_name ?? null,
            rankingDate: window.date,
            windowStart: window.start.toISOString(),
            windowEnd: window.end.toISOString(),
            rank: c.rank,
            score: c.score ?? '0',
            competitors: competitors.toString(),
            slots: slots.toString(),
          },
        );
      await m.query(
        'INSERT INTO regional_ranking_heads(region_code,run_id) VALUES($1,$2) ON CONFLICT(region_code) DO UPDATE SET run_id=EXCLUDED.run_id',
        [regionCode, runId],
      );
      return runId;
    });
  }
  async onModuleDestroy() {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    await this.running;
  }
}
