#!/usr/bin/env bash
# Fixed allowlist bridge: legacy safe restart when no OID request exists;
# otherwise exact promotion/restart/attestation/rollback under the owner click.
set -euo pipefail
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
REPO_ROOT="$(cd -- "$SCRIPT_DIR/.." >/dev/null 2>&1 && pwd -P)"
if [ -L "$REPO_ROOT/.git" ]; then
  echo 'OID control Git entry is unsafe.' >&2
  exit 2
fi
GIT_COMMON_DIR="$(/usr/bin/git -C "$REPO_ROOT" rev-parse --path-format=absolute --git-common-dir 2>/dev/null)" || {
  echo 'OID control Git directory cannot be resolved.' >&2; exit 2;
}
if [ ! -d "$GIT_COMMON_DIR" ] || [ -L "$GIT_COMMON_DIR" ] || [ "$(readlink -f -- "$GIT_COMMON_DIR")" != "$GIT_COMMON_DIR" ]; then
  echo 'OID control Git directory is unsafe.' >&2
  exit 2
fi
OID_REQUEST="$GIT_COMMON_DIR/nassaj-preview-oid-control-request-v1.json"
if { [ -e "$OID_REQUEST" ] || [ -L "$OID_REQUEST" ]; }; then
  if [ "${1:-}" = "--exec" ]; then
    exec /usr/bin/node "$SCRIPT_DIR/../dist-server/scripts/preview-oid-capsule-launcher.mjs"
  fi
  if [ "${1:-}" = "--json" ] || [ "${1:-}" = "--gate" ]; then
    echo 'OID gate is owned by the loaded immutable capsule; root fallback refused.' >&2
    exit 2
  fi
fi
exec /usr/bin/node "$SCRIPT_DIR/preview-oid-owner-action.mjs" "$@"
