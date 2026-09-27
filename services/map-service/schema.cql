CREATE KEYSPACE IF NOT EXISTS wgo_map WITH replication = {'class': 'SimpleStrategy', 'replication_factor': 1};
CREATE TABLE IF NOT EXISTS wgo_map.user_locations (
  user_id bigint PRIMARY KEY,
  latitude double,
  longitude double,
  updated_at timestamp
);
