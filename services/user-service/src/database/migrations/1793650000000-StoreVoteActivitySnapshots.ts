import type { MigrationInterface, QueryRunner } from 'typeorm';

export class StoreVoteActivitySnapshots1793650000000
  implements MigrationInterface
{
  name = 'StoreVoteActivitySnapshots1793650000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE user_activities DROP CONSTRAINT user_activities_kind_check;
      ALTER TABLE user_activities ADD CONSTRAINT user_activities_kind_check
        CHECK(kind IN ('POST','COMMENT','PARTICIPATION','POST_REACTION','COMMENT_REACTION','VOTE_CANDIDATE','VOTE_WIN'));
      ALTER TABLE user_activities
        ADD COLUMN source_region_code varchar(10),
        ADD COLUMN source_region_state text NOT NULL DEFAULT 'LEGACY'
          CHECK(source_region_state IN ('LEGACY','MISSING','NULL','KNOWN')),
        ADD COLUMN source_region_event_id text,
        ADD COLUMN score_at_selection bigint CHECK(score_at_selection >= 0),
        ADD CONSTRAINT chk_vote_source_region CHECK(
          (source_region_state='KNOWN' AND source_region_code IS NOT NULL AND source_region_code ~ '^[0-9]{10}$')
          OR (source_region_state<>'KNOWN' AND source_region_code IS NULL));
      CREATE INDEX ix_vote_activity_region_window ON user_activities(source_region_code,occurred_at,actor_id,post_id)
        WHERE kind IN ('VOTE_CANDIDATE','VOTE_WIN') AND source_time_verified;
      CREATE UNIQUE INDEX uq_vote_candidate_comment ON user_activities(post_id,comment_id) WHERE kind='VOTE_CANDIDATE';
      CREATE OR REPLACE VIEW reward_title_valid_activities AS SELECT a.* FROM user_activities a
        LEFT JOIN reward_posts p ON p.post_id=a.post_id
        WHERE (a.active OR (a.kind='POST' AND p.status='EXPIRED')) AND COALESCE(p.status,'ACTIVE')<>'DELETED'
        AND NOT EXISTS(SELECT 1 FROM user_activities c WHERE c.kind='COMMENT'
          AND c.comment_id=a.comment_id AND c.post_id=a.post_id AND NOT c.active);
      UPDATE regional_ranking_state SET input_revision=input_revision+1 WHERE singleton=true;
    `);
    // Do not infer event regions from the mutable post-level projection. Legacy facts,
    // policy definitions, ledger, awards and ranking snapshots all survive unchanged.
  }
  async down(): Promise<void> {
    // A destructive rollback would erase received candidate/region facts. Roll forward
    // or restore an operator-approved backup instead of silently dropping that history.
    throw new Error(
      'Vote activity snapshots require a forward migration; history must be preserved',
    );
  }
}
