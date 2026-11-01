#!/bin/bash
set -euo pipefail
# Run once for a new namespace. Reusing a directory must never rotate a live DB's password.
namespace=${1:?Usage: gcp-storage-secrets.sh NAMESPACE OUTPUT_DIRECTORY}
out=${2:?An absolute directory outside the repository is required}
[[ "$namespace" =~ ^[a-z][a-z0-9-]{2,62}$ ]] || exit 2
[[ "$out" = /* && ! -e "$out" ]] || { echo 'Output must be a new absolute directory' >&2; exit 2; }
case "$out" in "$(pwd)"/*) echo 'Keep private material outside the repository' >&2; exit 2;; esac
command -v openssl >/dev/null
command -v keytool >/dev/null
existing=$(kubectl -n "$namespace" get secret wgo-storage-credentials --ignore-not-found -o name)
[[ -z "$existing" ]] || { echo 'Storage credentials already exist; use a reviewed rotation procedure' >&2; exit 2; }
umask 077
mkdir -p "$out"
password() { openssl rand -base64 36 | tr '+/' '-_' | tr -d '=\n'; }
for key in mongodb-root-password mongodb-post-password redis-password cassandra-admin-password cassandra-map-password cassandra-keystore-password; do password > "$out/$key"; done
openssl rand -base64 96 > "$out/keyfile"
openssl req -x509 -newkey rsa:3072 -nodes -days 365 -subj '/CN=WGO demo storage CA' -keyout "$out/ca.key" -out "$out/ca.pem" 2>/dev/null
for service in mongodb redis cassandra; do
  cat > "$out/$service.ext" <<CONFIG
basicConstraints=CA:FALSE
keyUsage=digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:localhost,DNS:$service,DNS:$service.$namespace,DNS:$service.$namespace.svc,DNS:$service.$namespace.svc.cluster.local,DNS:$service-0.$service,DNS:$service-0.$service.$namespace.svc.cluster.local,IP:127.0.0.1
CONFIG
  openssl req -new -newkey rsa:3072 -nodes -subj "/CN=$service.$namespace.svc.cluster.local" -keyout "$out/$service.key" -out "$out/$service.csr" 2>/dev/null
  openssl x509 -req -in "$out/$service.csr" -CA "$out/ca.pem" -CAkey "$out/ca.key" -CAcreateserial -days 90 -extfile "$out/$service.ext" -out "$out/$service.crt" 2>/dev/null
  openssl verify -CAfile "$out/ca.pem" "$out/$service.crt" >/dev/null
done
cat "$out/mongodb.key" "$out/mongodb.crt" > "$out/mongodb.pem"
openssl pkcs12 -export -in "$out/cassandra.crt" -inkey "$out/cassandra.key" -certfile "$out/ca.pem" -name cassandra -out "$out/cassandra.p12" -passout "file:$out/cassandra-keystore-password"
keytool -importkeystore -noprompt -srckeystore "$out/cassandra.p12" -srcstoretype PKCS12 -srcstorepass:file "$out/cassandra-keystore-password" -destkeystore "$out/cassandra.jks" -deststoretype JKS -deststorepass:file "$out/cassandra-keystore-password" >/dev/null 2>&1
kubectl -n "$namespace" create secret generic wgo-storage-credentials \
  --from-file="$out/mongodb-root-password" --from-file="$out/mongodb-post-password" \
  --from-file="$out/redis-password" --from-file="$out/cassandra-admin-password" \
  --from-file="$out/cassandra-map-password" --from-file="$out/cassandra-keystore-password" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$namespace" create secret generic wgo-storage-tls \
  --from-file="mongodb-ca.pem=$out/ca.pem" --from-file="redis-ca.pem=$out/ca.pem" --from-file="cassandra-ca.pem=$out/ca.pem" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$namespace" create secret generic mongodb-server-tls \
  --from-file="server.pem=$out/mongodb.pem" --from-file="ca.pem=$out/ca.pem" --from-file="$out/keyfile" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$namespace" create secret generic redis-server-tls \
  --from-file="server.crt=$out/redis.crt" --from-file="server.key=$out/redis.key" --from-file="ca.pem=$out/ca.pem" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$namespace" create secret generic cassandra-server-tls \
  --from-file="$out/cassandra.jks" --from-file="ca.pem=$out/ca.pem" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$namespace" label secret wgo-storage-credentials wgo-storage-tls mongodb-server-tls redis-server-tls cassandra-server-tls wgo/backup=databases --overwrite
printf 'Created storage credentials and TLS secrets. Private material remains in %s.\n' "$out"
