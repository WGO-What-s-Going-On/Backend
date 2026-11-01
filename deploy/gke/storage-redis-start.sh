#!/bin/sh
set -eu
password=$(cat /credentials/redis-password)
case "$password" in ''|*[!A-Za-z0-9_-]*) echo 'Invalid Redis password format' >&2; exit 1;; esac
umask 077
cat > /tmp/redis.conf <<CONFIG
bind 0.0.0.0
port 0
tls-port 6379
tls-cert-file /tls/server.crt
tls-key-file /tls/server.key
tls-ca-cert-file /tls/ca.pem
tls-auth-clients no
requirepass $password
dir /data
appendonly yes
appendfsync always
maxmemory 768mb
maxmemory-policy noeviction
save 300 1
CONFIG
exec redis-server /tmp/redis.conf
