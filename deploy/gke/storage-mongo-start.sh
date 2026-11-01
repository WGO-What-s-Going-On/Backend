#!/bin/sh
set -eu
mongod --bind_ip_all --port 27017 --dbpath /data/db --replSet rs0 --auth \
  --keyFile /private/keyfile --tlsMode requireTLS --tlsCertificateKeyFile /private/server.pem \
  --tlsCAFile /private/ca.pem --tlsAllowConnectionsWithoutCertificates &
pid=$!
trap 'kill -TERM "$pid"; wait "$pid"' TERM INT
ready=false
for attempt in $(seq 1 120); do
  if mongosh --quiet --tls --tlsCAFile /private/ca.pem --host localhost --eval 'db.adminCommand({ping:1})' >/dev/null 2>&1; then ready=true; break; fi
  kill -0 "$pid"
  sleep 2
done
if [ "$ready" != true ]; then kill -TERM "$pid"; exit 1; fi
if ! mongosh --quiet --tls --tlsCAFile /private/ca.pem --host localhost /bootstrap/mongo-init.js; then
  kill -TERM "$pid"
  wait "$pid" || true
  exit 1
fi
wait "$pid"
