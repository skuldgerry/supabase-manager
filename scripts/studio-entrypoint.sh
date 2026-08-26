#!/bin/sh
set -eu

: "${MANAGER_INTERNAL_TOKEN_FILE:=/run/supabase-manager/internal-token}"

attempt=0
while [ ! -s "$MANAGER_INTERNAL_TOKEN_FILE" ]; do
  attempt=$((attempt + 1))
  if [ "$attempt" -ge 60 ]; then
    echo "The private manager token was not initialized by the broker" >&2
    exit 1
  fi
  sleep 1
done

MANAGER_INTERNAL_TOKEN="$(tr -d '\r\n' < "$MANAGER_INTERNAL_TOKEN_FILE")"
if [ "${#MANAGER_INTERNAL_TOKEN}" -lt 32 ]; then
  echo "The private manager token is invalid" >&2
  exit 1
fi

export MANAGER_INTERNAL_TOKEN
export STUDIO_SESSION_SECRET="$MANAGER_INTERNAL_TOKEN"

exec "$@"
