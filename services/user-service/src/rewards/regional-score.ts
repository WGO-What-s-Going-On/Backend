import { TITLE_POLICY } from './title-policy.js';

// $1/$2 are the half-open Seoul window. Ranking and API progress use the same
// projection, so raw duplicate candidates never inflate either score or evidence.
export const REGIONAL_SCORE_CTES = `regional_facts AS (
  SELECT a.*,COALESCE(p.representative_wins,0) AS representative_wins FROM reward_title_valid_activities a
  JOIN users u ON u.id=a.beneficiary_id AND u.status='ACTIVE'
  LEFT JOIN user_title_progress p ON p.user_id=u.id
  WHERE a.kind IN ('VOTE_CANDIDATE','VOTE_WIN') AND a.source_time_verified
    AND a.source_region_state='KNOWN' AND a.occurred_at>=$1 AND a.occurred_at<$2
),candidate_choices AS (
  SELECT *,row_number() OVER(PARTITION BY post_id,actor_id ORDER BY occurred_at,activity_key) AS choice
  FROM regional_facts WHERE kind='VOTE_CANDIDATE'
),scoring_facts AS (
  SELECT activity_key,post_id,comment_id,result_id,beneficiary_id AS user_id,kind,
    occurred_at,source_region_code AS region_code,representative_wins,${TITLE_POLICY.regionalScoring.candidate}::bigint AS points
  FROM candidate_choices WHERE choice=1
  UNION ALL
  SELECT activity_key,post_id,comment_id,result_id,beneficiary_id AS user_id,kind,
    occurred_at,source_region_code AS region_code,representative_wins,${TITLE_POLICY.regionalScoring.winner}::bigint AS points
  FROM regional_facts WHERE kind='VOTE_WIN' AND result_id IS NOT NULL
),regional_totals AS (
  SELECT region_code,user_id,sum(points)::bigint AS score,max(occurred_at) AS last_selected_at,
    max(representative_wins) AS qualifying_wins,
    jsonb_agg(jsonb_build_object('activityKey',activity_key,'kind',kind,'points',points,
      'postId',post_id,'commentId',comment_id,'resultId',result_id,'regionCode',region_code,
      'selectedAt',CASE WHEN kind='VOTE_CANDIDATE' THEN occurred_at END,
      'closedAt',CASE WHEN kind='VOTE_WIN' THEN occurred_at END)
      ORDER BY occurred_at,activity_key) AS evidence
  FROM scoring_facts GROUP BY region_code,user_id
)`;
