#!/bin/sh
set -eu

umask 077

: "${MANAGER_DATA_DIR:=/data}"
: "${MANAGER_PORT:=3000}"
: "${MANAGER_BIND_ADDRESS:=0.0.0.0}"
: "${DOCKER_SOCKET_PATH:=/var/run/docker.sock}"

export MANAGER_DATA_DIR MANAGER_PORT MANAGER_BIND_ADDRESS DOCKER_SOCKET_PATH
export NODE_ENV="${NODE_ENV:-production}"
export PORT="${PORT:-$MANAGER_PORT}"
# Next's standalone server reads HOSTNAME. Docker commonly injects a container
# hostname, so explicitly prefer the configured bind address here.
export HOSTNAME="$MANAGER_BIND_ADDRESS"

mkdir -p "$MANAGER_DATA_DIR"

if [ ! -f /app/server.js ]; then
  echo "Supabase Manager standalone server is missing" >&2
  exit 1
fi

exec /sbin/tini -- node /app/server.js
