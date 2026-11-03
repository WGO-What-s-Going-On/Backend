import type { PoolClient } from 'pg';

export async function migrateCrossService(client: PoolClient) {
  if (
    (
      await client.query(
        'SELECT 1 FROM notification_schema_versions WHERE version=2',
      )
    ).rowCount
  )
    return;
  await client.query(`
    CREATE TABLE notification_event_inbox (
      source_stream text NOT NULL,event_id text NOT NULL,details jsonb NOT NULL,
      processed_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(source_stream,event_id));
    CREATE TABLE notification_stream_starts (
      source_stream text NOT NULL,consumer_group text NOT NULL,start_id text NOT NULL,
      PRIMARY KEY(source_stream,consumer_group));
    CREATE TABLE notification_business_keys (
      source_stream text NOT NULL,business_key text NOT NULL,recipient text NOT NULL,
      notification_id text NOT NULL,PRIMARY KEY(source_stream,business_key,recipient));
    ALTER TABLE notification_deliveries ADD COLUMN scope_id text;
    UPDATE notification_deliveries SET scope_id='post:'||post_id;
    ALTER TABLE notification_deliveries DROP CONSTRAINT notification_deliveries_pkey;
    ALTER TABLE notification_deliveries ALTER COLUMN post_id DROP NOT NULL;
    ALTER TABLE notification_deliveries ALTER COLUMN scope_id SET NOT NULL;
    ALTER TABLE notification_deliveries ADD PRIMARY KEY(scope_id,key);
    CREATE FUNCTION notification_delivery_scope() RETURNS trigger LANGUAGE plpgsql AS $$
    BEGIN
      IF NEW.scope_id IS NULL AND NEW.post_id IS NOT NULL THEN NEW.scope_id='post:'||NEW.post_id; END IF;
      RETURN NEW;
    END $$;
    CREATE TRIGGER notification_delivery_scope BEFORE INSERT ON notification_deliveries
      FOR EACH ROW EXECUTE FUNCTION notification_delivery_scope();
    CREATE TABLE notification_comment_states (
      post_id text NOT NULL,comment_id text NOT NULL,version bigint NOT NULL,
      deleted boolean NOT NULL,author_id text,parent_comment_id text,PRIMARY KEY(post_id,comment_id));
    CREATE TABLE notification_lifecycle_states (
      post_id text PRIMARY KEY,version bigint NOT NULL,state text NOT NULL,
      scheduled_close_at timestamptz,event_id text NOT NULL);
    INSERT INTO notification_schema_versions VALUES(2);
  `);
  // Legacy deliveries keep their real post foreign key. User/report deliveries
  // use a separate scope and NULL post_id; old writers are supported by the trigger.
}
