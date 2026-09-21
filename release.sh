#!/usr/bin/env bash
set -euo pipefail

# Validate Nassaj's exact four-part release identity. This script never reads
# .env and never performs a push; GitHub credentials remain owned by gh.
if [ "$#" -lt 1 ]; then
  echo "usage: $0 VERSION [--write]" >&2
  exit 2
fi

VERSION="$1"
shift
ARGS=(--version "$VERSION")
if [ "${1:-}" = "--write" ] && [ "$#" -eq 1 ]; then
  ARGS+=(--write)
elif [ "$#" -ne 0 ]; then
  echo "usage: $0 VERSION [--write]" >&2
  exit 2
fi

exec node scripts/prepare-release-version.mjs "${ARGS[@]}"
