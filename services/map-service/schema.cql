CREATE KEYSPACE IF NOT EXISTS wgo_map WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
CREATE TABLE IF NOT EXISTS wgo_map.user_locations (
  user_id bigint PRIMARY KEY,
  latitude double,
  longitude double,
  updated_at timestamp
);

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
