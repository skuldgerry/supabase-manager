#!/bin/sh
set -eu

token_file="${MANAGER_INTERNAL_TOKEN_FILE:-}"

if [ -n "$token_file" ] && [ -r "$token_file" ]; then
  internal_token="$(tr -d '\r\n' < "$token_file")"

  if [ -n "$internal_token" ]; then
    if [ -z "${MANAGER_INTERNAL_TOKEN:-}" ]; then
      export MANAGER_INTERNAL_TOKEN="$internal_token"
    fi

    if [ -z "${STUDIO_SESSION_SECRET:-}" ]; then
      export STUDIO_SESSION_SECRET="$internal_token"
    fi
  fi
fi

exec "$@"
