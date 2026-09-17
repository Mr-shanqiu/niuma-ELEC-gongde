#!/bin/sh
set -eu

password="$(cat /run/secrets/gongde_redis_password)"
case "$password" in
  *[!A-Za-z0-9_-]*|'') echo "invalid redis password" >&2; exit 78 ;;
esac
if [ "${#password}" -lt 32 ]; then echo "invalid redis password" >&2; exit 78; fi
umask 077
cat > /tmp/redis.conf <<EOF
bind 0.0.0.0
protected-mode yes
port 6379
appendonly yes
appendfsync everysec
requirepass $password
maxmemory 32mb
maxmemory-policy noeviction
EOF
exec redis-server /tmp/redis.conf
