CREATE KEYSPACE IF NOT EXISTS wgo_map WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
CREATE TABLE IF NOT EXISTS wgo_map.user_locations (
  user_id bigint PRIMARY KEY,
  latitude double,
  longitude double,
  updated_at timestamp
);

CREATE TABLE IF NOT EXISTS wgo_map.user_location_history (
  user_id bigint,
  day_bucket date,
  update_id timeuuid,
  latitude double,
  longitude double,
  updated_at timestamp,
  PRIMARY KEY ((user_id, day_bucket), update_id)
) WITH CLUSTERING ORDER BY (update_id DESC)
  AND default_time_to_live = 604800
  AND compaction = {'class': 'TimeWindowCompactionStrategy', 'compaction_window_unit': 'HOURS', 'compaction_window_size': '6'};

CREATE TABLE IF NOT EXISTS wgo_map.post_locations (
  post_id text PRIMARY KEY,
  event_id text,
  author_id bigint,
  latitude double,
  longitude double,
  radius_m int,
  category text,
  expires_at timestamp,
  cell text,
  shard int
);

CREATE TABLE IF NOT EXISTS wgo_map.post_status (
  post_id text PRIMARY KEY,
  status text,
  occurred_at timestamp
);

CREATE TABLE IF NOT EXISTS wgo_map.posts_by_cell (
  cell text,
  shard int,
  post_id text,
  latitude double,
  longitude double,
  radius_m int,
  category text,
  expires_at timestamp,
  PRIMARY KEY ((cell, shard), post_id)
);
