#!/bin/sh
set -eu

umask 077

: "${MANAGER_DATA_DIR:=/data}"
: "${MANAGER_PORT:=3000}"
: "${MANAGER_BIND_ADDRESS:=0.0.0.0}"
: "${DOCKER_SOCKET_PATH:=/var/run/docker.sock}"
: "${MANAGER_INTERNAL_TOKEN_FILE:=/run/supabase-manager/internal-token}"

export MANAGER_DATA_DIR MANAGER_PORT MANAGER_BIND_ADDRESS DOCKER_SOCKET_PATH MANAGER_INTERNAL_TOKEN_FILE
export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-$MANAGER_PORT}"
# Next's standalone server reads HOSTNAME. Docker commonly injects a container
# hostname, so explicitly prefer the configured bind address here.
export HOSTNAME="$MANAGER_BIND_ADDRESS"

mkdir -p "$MANAGER_DATA_DIR"
mkdir -p "$(dirname "$MANAGER_INTERNAL_TOKEN_FILE")"

if [ ! -s "$MANAGER_INTERNAL_TOKEN_FILE" ]; then
  temporary_token="${MANAGER_INTERNAL_TOKEN_FILE}.tmp.$$"
  openssl rand -hex 32 > "$temporary_token"
  chmod 0600 "$temporary_token"
  mv "$temporary_token" "$MANAGER_INTERNAL_TOKEN_FILE"
fi

if [ ! -f /app/server.js ]; then
  echo "Supabase Manager standalone server is missing" >&2
  exit 1
fi

exec /sbin/tini -- node /app/server.js
