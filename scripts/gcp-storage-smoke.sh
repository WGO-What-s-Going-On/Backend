#!/bin/bash
set -euo pipefail
namespace=${1:?Usage: gcp-storage-smoke.sh NAMESPACE}
[[ "$namespace" =~ ^[a-z][a-z0-9-]{2,62}$ ]] || exit 2
for name in mongodb redis cassandra; do kubectl -n "$namespace" rollout status "statefulset/$name" --timeout=600s; done
kubectl -n "$namespace" exec mongodb-0 -- mongosh --quiet --tls --tlsCAFile /private/ca.pem --host localhost /bootstrap/mongo-smoke.js
kubectl -n "$namespace" exec redis-0 -- sh -eu -c '
  export REDISCLI_AUTH="$(cat /credentials/redis-password)"
  redis-cli --tls --cacert /tls/ca.pem -h localhost ping | grep -qx PONG
  key="wgo:storage-probe:$(date +%s)"
  redis-cli --tls --cacert /tls/ca.pem -h localhost XADD "$key" "*" test value >/dev/null
  redis-cli --tls --cacert /tls/ca.pem -h localhost XLEN "$key" | grep -qx 1
  redis-cli --tls --cacert /tls/ca.pem -h localhost DEL "$key" >/dev/null
  echo "Redis TLS authentication and Streams passed"
'
kubectl -n "$namespace" exec cassandra-0 -- cqlsh --ssl --cqlshrc /tmp/cqlshrc localhost 9042 -e 'SELECT post_id FROM wgo_map.post_status LIMIT 1'
kubectl -n "$namespace" get elasticsearch elasticsearch -o jsonpath='{.status.health}{"\n"}' | grep -Ex 'green|yellow'
echo 'Storage connectivity probes passed. Pod replacement and backup restoration remain separate checks.'
