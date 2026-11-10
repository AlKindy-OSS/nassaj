#!/usr/bin/env bash
# Run a command with core dumps disabled. Test workers inherit this hard limit,
# so a Node/V8 abort cannot fill the repository and the host filesystem.
# B-1771: the command also runs with a throwaway HOME and no provider credential
# (scripts/lib/isolated-test-env.mjs), so no test can write a live credential.
set -euo pipefail

if [[ $# -eq 0 ]]; then
  echo "Usage: bash scripts/run-without-core.sh <command> [args...]" >&2
  exit 64
fi

ulimit -S -c 0
if [[ "$(ulimit -S -c)" != "0" ]]; then
  echo "Refusing to start: the core dump limit is not zero." >&2
  exit 70
fi

exec node "$(dirname "${BASH_SOURCE[0]}")/lib/isolated-test-env.mjs" "$@"
