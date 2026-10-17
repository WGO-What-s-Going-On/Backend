import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddActivityRewards1792190000000 implements MigrationInterface {
  name = 'AddActivityRewards1792190000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      CREATE TABLE reward_policies (version text PRIMARY KEY, definition jsonb NOT NULL);
      CREATE TABLE reward_inbox (event_id text PRIMARY KEY, processed_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE reward_posts (
        post_id text PRIMARY KEY, version bigint NOT NULL CHECK(version > 0),
        status text NOT NULL CHECK(status IN ('ACTIVE','DELETED','EXPIRED'))
      );
      CREATE TABLE user_activities (
        activity_key text PRIMARY KEY, post_id text NOT NULL,
        kind text NOT NULL CHECK(kind IN ('POST','COMMENT','PARTICIPATION','POST_REACTION','COMMENT_REACTION','VOTE_WIN')),
        actor_id bigint NOT NULL CHECK(actor_id BETWEEN 1 AND 9007199254740991),
        beneficiary_id bigint CHECK(beneficiary_id BETWEEN 1 AND 9007199254740991), reaction_type text,
        version bigint NOT NULL CHECK(version > 0), active boolean NOT NULL,
        event_id text NOT NULL, correlation_id text NOT NULL,
        eligibility text NOT NULL DEFAULT 'PENDING_POLICY', updated_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE INDEX ix_user_activities_post ON user_activities(post_id, activity_key);
      CREATE INDEX ix_user_activities_actor ON user_activities(actor_id, kind);
      CREATE INDEX ix_user_activities_beneficiary ON user_activities(beneficiary_id, kind);
      CREATE TABLE user_growth (
        user_id bigint PRIMARY KEY REFERENCES users(id),
        credits bigint NOT NULL DEFAULT 0 CHECK(credits >= 0),
        growth_score bigint NOT NULL DEFAULT 0 CHECK(growth_score >= 0),
        level integer, policy_version text REFERENCES reward_policies(version)
      );
      CREATE TABLE credit_ledger (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES users(id), activity_key text NOT NULL REFERENCES user_activities(activity_key),
        event_id text NOT NULL, policy_version text NOT NULL REFERENCES reward_policies(version),
        credits bigint NOT NULL CHECK(credits <> 0), growth bigint NOT NULL,
        created_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE(activity_key, event_id, policy_version)
      );
      CREATE INDEX ix_credit_ledger_user ON credit_ledger(user_id, id DESC);
      CREATE TABLE user_level_history (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES users(id), previous_level integer, level integer NOT NULL,
        policy_version text NOT NULL REFERENCES reward_policies(version), created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE TABLE user_badge_history (
        id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
        user_id bigint NOT NULL REFERENCES users(id), badge_id bigint NOT NULL REFERENCES badges(id),
        action text NOT NULL CHECK(action IN ('GRANTED','REVOKED')),
        policy_version text NOT NULL REFERENCES reward_policies(version), created_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE user_badge_history, user_level_history, credit_ledger,
      user_growth, user_activities, reward_posts, reward_inbox, reward_policies`);
  }
}
