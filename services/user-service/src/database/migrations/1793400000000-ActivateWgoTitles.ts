import type { MigrationInterface, QueryRunner } from 'typeorm';
import { seedBadgeCatalog } from '../../rewards/badge-catalog.js';
export class ActivateWgoTitles1793400000000 implements MigrationInterface {
  name = 'ActivateWgoTitles1793400000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE user_activities ADD COLUMN source_time_verified boolean NOT NULL DEFAULT false;
      CREATE INDEX ix_title_actor_current ON user_activities(actor_id,kind) WHERE active;
      CREATE INDEX ix_title_agree_comment ON user_activities(beneficiary_id,comment_id,actor_id)
        WHERE kind='COMMENT_REACTION' AND reaction_type='AGREE' AND active;
      CREATE INDEX ix_title_vote_window ON user_activities(occurred_at,beneficiary_id,post_id)
        WHERE kind='VOTE_WIN' AND source_time_verified;
      CREATE VIEW reward_title_valid_activities AS SELECT a.* FROM user_activities a
        LEFT JOIN reward_posts p ON p.post_id=a.post_id
        WHERE (a.active OR (a.kind='POST' AND p.status='EXPIRED')) AND COALESCE(p.status,'ACTIVE')<>'DELETED'
        AND NOT EXISTS(SELECT 1 FROM user_activities c WHERE c.kind='COMMENT'
          AND c.comment_id=a.comment_id AND c.post_id=a.post_id AND NOT c.active);
      CREATE TABLE user_title_progress (
        user_id bigint PRIMARY KEY REFERENCES users(id), participation bigint NOT NULL DEFAULT 0,
        reporter_comments bigint NOT NULL DEFAULT 0, representative_wins bigint NOT NULL DEFAULT 0,
        account_status text NOT NULL, highest_stage smallint NOT NULL DEFAULT 0 CHECK(highest_stage BETWEEN 0 AND 4),
        achieved_stages jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE reward_post_regions (
        post_id text PRIMARY KEY, version bigint NOT NULL CHECK(version>0),
        region_code varchar(10), region_name text, event_id text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now(),
        CHECK((region_code IS NULL)=(region_name IS NULL)),CHECK(region_code IS NULL OR region_code ~ '^[0-9]{10}$')
      );
      CREATE INDEX ix_reward_post_region ON reward_post_regions(region_code,post_id);
      CREATE TABLE reward_post_region_history (
        post_id text NOT NULL, version bigint NOT NULL, region_code varchar(10),region_name text,event_id text NOT NULL,
        recorded_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(post_id,version)
      );
      CREATE TABLE regional_ranking_state(singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),input_revision bigint NOT NULL DEFAULT 0);
      INSERT INTO regional_ranking_state DEFAULT VALUES;
      CREATE TABLE regional_ranking_runs (
        id uuid PRIMARY KEY, region_code varchar(10) NOT NULL, ranking_date date NOT NULL,
        window_start timestamptz NOT NULL,window_end timestamptz NOT NULL,input_revision bigint NOT NULL,
        policy_version text NOT NULL REFERENCES reward_policies(version),competitors bigint NOT NULL,slots bigint NOT NULL,
        suppressed_reason text,created_at timestamptz NOT NULL DEFAULT now(),UNIQUE(region_code,ranking_date,input_revision)
      );
      CREATE TABLE regional_ranking_entries (
        run_id uuid NOT NULL REFERENCES regional_ranking_runs(id), user_id bigint NOT NULL REFERENCES users(id),
        score bigint NOT NULL,rank bigint NOT NULL,selected boolean NOT NULL,last_selected_at timestamptz NOT NULL,
        qualifying_wins bigint NOT NULL,evidence jsonb NOT NULL,PRIMARY KEY(run_id,user_id)
      );
      CREATE INDEX ix_regional_ranking_user ON regional_ranking_entries(user_id,run_id);
      CREATE TABLE regional_ranking_heads(region_code varchar(10) PRIMARY KEY,run_id uuid NOT NULL REFERENCES regional_ranking_runs(id));
      CREATE TABLE user_regional_badges (
        user_id bigint NOT NULL REFERENCES users(id),badge_id bigint NOT NULL REFERENCES badges(id),region_code varchar(10) NOT NULL,
        granted_at timestamptz NOT NULL DEFAULT now(),revoked_at timestamptz,run_id uuid NOT NULL REFERENCES regional_ranking_runs(id),
        PRIMARY KEY(user_id,badge_id,region_code)
      );
      CREATE INDEX ix_regional_badge_holders ON user_regional_badges(region_code,user_id) WHERE revoked_at IS NULL;
      ALTER TABLE user_badge_history ADD COLUMN region_code varchar(10),ADD COLUMN ranking_run_id uuid REFERENCES regional_ranking_runs(id),ADD COLUMN reason text;
    `);
    // Default-on titles must not depend on an operator remembering a separate seed step.
    await seedBadgeCatalog(q.manager);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`ALTER TABLE user_badge_history DROP COLUMN region_code,DROP COLUMN ranking_run_id,DROP COLUMN reason;
      DROP TABLE user_regional_badges,regional_ranking_heads,regional_ranking_entries,regional_ranking_runs,regional_ranking_state,
        reward_post_region_history,reward_post_regions,user_title_progress;
      DROP VIEW reward_title_valid_activities;
      DROP INDEX ix_title_actor_current;DROP INDEX ix_title_agree_comment;DROP INDEX ix_title_vote_window;
      ALTER TABLE user_activities DROP COLUMN source_time_verified`);
    // Existing catalog rows and awards deliberately survive a rollback.
  }
}
