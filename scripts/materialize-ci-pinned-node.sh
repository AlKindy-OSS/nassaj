#!/usr/bin/env bash
set -euo pipefail

source_node=${1:-}
target_node=/usr/bin/node

[[ "$source_node" = /* && -x "$source_node" ]]
[[ ! -e "$target_node" && ! -L "$target_node" ]]
sudo install --owner=root --group=root --mode=0755 "$source_node" "$target_node"
[[ "$(stat -c %F "$target_node")" == 'regular file' && ! -L "$target_node" ]]
[[ "$(stat -c %u:%g "$target_node")" == '0:0' ]]
target_mode=$(stat -c %a "$target_node")
(( (8#$target_mode & 8#022) == 0 ))
[[ "$(stat -c %d:%i "$source_node")" != "$(stat -c %d:%i "$target_node")" ]]
[[ "$(sha256sum "$source_node" | cut -d' ' -f1)" == "$(sha256sum "$target_node" | cut -d' ' -f1)" ]]
[[ -n "${GITHUB_PATH:-}" ]]
echo '/usr/bin' >> "$GITHUB_PATH"
