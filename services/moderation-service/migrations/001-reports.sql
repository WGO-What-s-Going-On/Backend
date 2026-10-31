BEGIN;
-- Apply only to a Moderation-owned database. No references to other services' tables.
CREATE TABLE moderation_reports (
  report_id text PRIMARY KEY,
  reporter_user_id bigint NOT NULL CHECK (reporter_user_id BETWEEN 1 AND 9007199254740991),
  target_type text NOT NULL CHECK (target_type IN ('POST','COMMENT')),
  post_id text NOT NULL,
  comment_id text NOT NULL,
  document jsonb NOT NULL,
  CHECK ((target_type='POST' AND comment_id='') OR (target_type='COMMENT' AND comment_id<>'')),
  CHECK (document->>'status' IN ('PENDING','WITHDRAWN','REVIEWED')),
  UNIQUE (reporter_user_id, target_type, post_id, comment_id)
);
CREATE TABLE moderation_report_outbox (
  sequence bigserial PRIMARY KEY,
  event_id uuid NOT NULL UNIQUE,
  report_id text NOT NULL REFERENCES moderation_reports(report_id),
  event_type text NOT NULL CHECK (event_type IN ('REPORT_CREATED','REPORT_WITHDRAWN')),
  envelope jsonb NOT NULL,
  attempts integer NOT NULL DEFAULT 0,
  published_at timestamptz
);
CREATE INDEX moderation_report_outbox_pending ON moderation_report_outbox(sequence) WHERE published_at IS NULL;
CREATE INDEX moderation_report_outbox_report_pending ON moderation_report_outbox(report_id, sequence) WHERE published_at IS NULL;
COMMIT;
