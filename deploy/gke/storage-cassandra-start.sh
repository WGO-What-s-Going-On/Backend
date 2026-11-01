#!/bin/bash
set -euo pipefail
python3 /bootstrap/cassandra-config.py
docker-entrypoint.sh cassandra -f &
pid=$!
trap 'kill -TERM "$pid"; wait "$pid"' TERM INT
umask 077
admin_password=$(cat /credentials/cassandra-admin-password)
map_password=$(cat /credentials/cassandra-map-password)
for password in "$admin_password" "$map_password"; do
  case "$password" in ''|*[!A-Za-z0-9_-]*) echo 'Invalid Cassandra password format' >&2; kill -TERM "$pid"; exit 1;; esac
done
write_config() {
  cat > /tmp/cqlshrc <<CONFIG
[authentication]
username = cassandra
password = $1
[ssl]
validate = true
certfile = /tls/ca.pem
CONFIG
}
ready=false
for attempt in $(seq 1 180); do
  write_config "$admin_password"
  if cqlsh --ssl --cqlshrc /tmp/cqlshrc localhost 9042 -e 'SELECT release_version FROM system.local' >/dev/null 2>&1; then ready=true; break; fi
  write_config cassandra
  if cqlsh --ssl --cqlshrc /tmp/cqlshrc localhost 9042 -e 'SELECT release_version FROM system.local' >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$pid"
  sleep 2
done
if [ "$ready" != true ]; then kill -TERM "$pid"; exit 1; fi
# Passwords are generated base64url values and never printed or passed as CLI arguments.
cat > /tmp/bootstrap.cql <<CQL
ALTER ROLE cassandra WITH PASSWORD = '$admin_password';
CQL
if ! cqlsh --ssl --cqlshrc /tmp/cqlshrc localhost 9042 -f /tmp/bootstrap.cql; then kill -TERM "$pid"; exit 1; fi
write_config "$admin_password"
# Authentication caches can briefly retain the old password after ALTER ROLE.
reauthenticated=false
for attempt in $(seq 1 30); do
  if cqlsh --ssl --cqlshrc /tmp/cqlshrc localhost 9042 -e 'SELECT release_version FROM system.local' >/dev/null 2>&1; then reauthenticated=true; break; fi
  sleep 1
done
if [ "$reauthenticated" != true ]; then kill -TERM "$pid"; exit 1; fi
cat /bootstrap/schema.cql > /tmp/bootstrap.cql
cat >> /tmp/bootstrap.cql <<CQL
CREATE ROLE IF NOT EXISTS wgo_map WITH PASSWORD = '$map_password' AND LOGIN = true;
GRANT SELECT ON KEYSPACE wgo_map TO wgo_map;
GRANT MODIFY ON KEYSPACE wgo_map TO wgo_map;
CQL
if ! cqlsh --ssl --cqlshrc /tmp/cqlshrc localhost 9042 -f /tmp/bootstrap.cql; then kill -TERM "$pid"; exit 1; fi
rm /tmp/bootstrap.cql
# Readiness uses the restricted application login, catching stale credentials after restore.
sed -i 's/username = cassandra/username = wgo_map/' /tmp/cqlshrc
sed -i "s/password = .*/password = $map_password/" /tmp/cqlshrc
wait "$pid"
