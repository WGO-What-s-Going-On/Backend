import type { MigrationInterface, QueryRunner } from 'typeorm';

export class AddTitlePolicyV31795300000000 implements MigrationInterface {
  name = 'AddTitlePolicyV31795300000000';
  async up(q: QueryRunner): Promise<void> {
    // Title inputs are separate so hiding content or voting cannot reprice credits or v2 awards.
    await q.query(`
      CREATE TABLE title_vote_selections (
        post_id text NOT NULL, user_id bigint NOT NULL, version bigint NOT NULL CHECK(version>0),
        comment_id text, event_id text NOT NULL, PRIMARY KEY(post_id,user_id)
      );
      CREATE INDEX ix_title_vote_user ON title_vote_selections(user_id) WHERE comment_id IS NOT NULL;
      CREATE TABLE title_hidden_content (
        kind text NOT NULL CHECK(kind IN ('POST','COMMENT')), target_id text NOT NULL,
        post_id text NOT NULL, version bigint NOT NULL CHECK(version>0), event_id text NOT NULL,
        PRIMARY KEY(kind,target_id)
      );
      CREATE TABLE user_title_v3_progress (
        user_id bigint PRIMARY KEY REFERENCES users(id),
        participation bigint NOT NULL, agree_received bigint NOT NULL, picks bigint NOT NULL,
        current_stage smallint NOT NULL CHECK(current_stage BETWEEN 0 AND 4),
        highest_stage smallint NOT NULL CHECK(highest_stage BETWEEN 0 AND 4),
        achieved_stages jsonb NOT NULL DEFAULT '{}', updated_at timestamptz NOT NULL DEFAULT now()
      );
    `);
  }
  async down(): Promise<void> {
    throw new Error(
      'Title v3 inputs and achievement history require a forward migration',
    );
  }
}
