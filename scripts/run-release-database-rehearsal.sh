#!/usr/bin/env bash
set -euo pipefail

runtime_root=$1
database_directory=$2
migration_entry=$3
database_path=$4
node_modules_root=${5:-}

[[ "$runtime_root" = /* && "$database_directory" = /* && "$migration_entry" = /* && "$database_path" = /* ]]
[[ -d "$runtime_root" && -d "$database_directory" && -f "$migration_entry" && -f "$database_path" ]]
[[ "$(realpath -e "$migration_entry")" == "$(realpath -e "$runtime_root")/"* ]]
[[ "$(realpath -e "$database_path")" == "$(realpath -e "$database_directory")/"* ]]

/usr/bin/mount --bind "$runtime_root" "$runtime_root"
/usr/bin/mount -o remount,bind,ro "$runtime_root"
node_read_args=("--allow-fs-read=$runtime_root")
if [[ -n "$node_modules_root" ]]; then
  [[ "$node_modules_root" = /* && -d "$node_modules_root" ]]
  /usr/bin/mount --bind "$node_modules_root" "$node_modules_root"
  /usr/bin/mount -o remount,bind,ro "$node_modules_root"
  node_read_args+=("--allow-fs-read=$node_modules_root")
fi
exec /usr/bin/node --permission --allow-addons \
  "${node_read_args[@]}" \
  "--allow-fs-read=$database_directory" \
  "--allow-fs-write=$database_directory" \
  "$migration_entry" --database "$database_path"
