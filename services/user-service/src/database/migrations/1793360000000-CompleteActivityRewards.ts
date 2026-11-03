import type { MigrationInterface, QueryRunner } from 'typeorm';
export class CompleteActivityRewards1793360000000
  implements MigrationInterface
{
  name = 'CompleteActivityRewards1793360000000';
  async up(q: QueryRunner): Promise<void> {
    await q.query(`
      ALTER TABLE user_activities ADD COLUMN comment_id text, ADD COLUMN result_id text,
        ADD COLUMN occurred_at timestamptz NOT NULL DEFAULT now();
      UPDATE user_activities SET occurred_at=updated_at,
        comment_id=CASE WHEN kind='COMMENT' THEN activity_key
          WHEN kind='COMMENT_REACTION' THEN substring(activity_key from '^(comment_[0-9a-f-]+):reaction:') ELSE NULL END,
        result_id=CASE WHEN kind='VOTE_WIN' THEN substring(activity_key from '^vote:(.*):[0-9]+$') ELSE NULL END;
      CREATE INDEX ix_reward_comment ON user_activities(post_id,comment_id) WHERE comment_id IS NOT NULL;
      CREATE UNIQUE INDEX uq_reward_vote_result ON user_activities(result_id) WHERE result_id IS NOT NULL;
      CREATE TABLE reward_entitlements (
        activity_key text PRIMARY KEY REFERENCES user_activities(activity_key),
        user_id bigint NOT NULL REFERENCES users(id), policy_version text NOT NULL REFERENCES reward_policies(version),
        amount bigint NOT NULL CHECK(amount>0), grants integer NOT NULL CHECK(grants>0),
        first_granted_at timestamptz NOT NULL DEFAULT now()
      );
      INSERT INTO reward_entitlements(activity_key,user_id,policy_version,amount,grants,first_granted_at)
        SELECT f.activity_key,f.user_id,f.policy_version,f.credits,c.grants,f.created_at
        FROM (SELECT DISTINCT ON(activity_key) * FROM credit_ledger WHERE credits>0 ORDER BY activity_key,id) f
        JOIN (SELECT activity_key,count(*)::integer AS grants FROM credit_ledger WHERE credits>0 GROUP BY activity_key) c USING(activity_key);
      CREATE TABLE reward_daily_usage (
        user_id bigint NOT NULL REFERENCES users(id), reward_day date NOT NULL,
        credits_granted bigint NOT NULL CHECK(credits_granted>=0), PRIMARY KEY(user_id,reward_day)
      );
      INSERT INTO reward_daily_usage SELECT user_id,(created_at AT TIME ZONE 'UTC')::date,sum(credits)
        FROM credit_ledger WHERE credits>0 GROUP BY user_id,(created_at AT TIME ZONE 'UTC')::date;
    `);
  }
  async down(q: QueryRunner): Promise<void> {
    await q.query(`DROP TABLE reward_daily_usage,reward_entitlements;
      DROP INDEX uq_reward_vote_result; DROP INDEX ix_reward_comment;
      ALTER TABLE user_activities DROP COLUMN comment_id,DROP COLUMN result_id,DROP COLUMN occurred_at`);
  }
}
