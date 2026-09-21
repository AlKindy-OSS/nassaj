#!/usr/bin/env bash
# Private filesystem root; mounts alone retain capabilities, application processes do not.
set -euo pipefail
lab_root=$1
original_home=$2
host_modules=$3
child_entry=$4
host_objects=$5
runtime_profile=${6:-host-local}
[[ "$runtime_profile" = host-local || "$runtime_profile" = fleet-public-24.17-npm12 ]]
[[ "$lab_root" = /*/.artifacts/t1772-bridge-rehearsal/run-* && "$(readlink -f "$lab_root")" = "$lab_root" ]]
[[ "$HOME" = "$original_home" && "$child_entry" = "$lab_root"/harness/* ]]
[[ "$(id -u)" != 0 ]]
[[ "$(readlink /proc/self/ns/user)" != "$NASSAJ_LAB_PARENT_USER_NS" ]]
[[ "$(readlink /proc/self/ns/mnt)" != "$NASSAJ_LAB_PARENT_MOUNT_NS" ]]
[[ "$(readlink /proc/self/ns/net)" != "$NASSAJ_LAB_PARENT_NET_NS" ]]
[[ "$(readlink /proc/self/ns/pid)" != "$NASSAJ_LAB_PARENT_PID_NS" ]]
private_root="$lab_root/rootfs"
mkdir -m700 "$private_root"
mkdir -p "$private_root/usr" "$private_root/proc" "$private_root/proc-reference" "$private_root/dev" "$private_root/etc" "$private_root/var/tmp" "$private_root/tmp" "$private_root/host-modules" "$private_root$original_home" "$private_root$lab_root"
for name in lib lib64 bin sbin; do
  [[ -L "/$name" && "$(readlink "/$name")" != /* ]]
  ln -s "$(readlink "/$name")" "$private_root/$name"
done
printf 'root:x:0:0:root:/root:/usr/bin/bash\nnassaj:x:%s:%s:isolated:%s:/usr/bin/bash\n' "$(id -u)" "$(id -g)" "$original_home" > "$private_root/etc/passwd"
printf 'root:x:0:\nnassaj:x:%s:\n' "$(id -g)" > "$private_root/etc/group"
printf '127.0.0.1 localhost\n::1 localhost\n' > "$private_root/etc/hosts"
printf 'passwd: files\ngroup: files\nhosts: files\n' > "$private_root/etc/nsswitch.conf"
[[ "$(readlink /usr/bin/which)" = /etc/alternatives/which ]]
[[ "$(readlink /etc/alternatives/which)" = /usr/bin/which.debianutils ]]
[[ "$(readlink -f /usr/bin/which)" = /usr/bin/which.debianutils && -f /usr/bin/which.debianutils && -x /usr/bin/which.debianutils && ! -L /usr/bin/which.debianutils ]]
mkdir -m700 "$private_root/etc/alternatives"
ln -s /usr/bin/which.debianutils "$private_root/etc/alternatives/which"
sha256sum /usr/bin/which.debianutils > "$lab_root/which-target.sha256"
/usr/bin/mount --make-rprivate /
/usr/bin/mount --bind "$private_root" "$private_root"
/usr/bin/mount --rbind -o ro=recursive /usr "$private_root/usr"
if [[ "$runtime_profile" = fleet-public-24.17-npm12 ]]; then
  public_tooling="${lab_root%/run-*}/run-Mx3eDp/tooling/usr"
  [[ "$(readlink -f "$public_tooling/bin/node")" = "$public_tooling/bin/node" && -f "$public_tooling/bin/node" && -x "$public_tooling/bin/node" ]]
  [[ "$(readlink -f /usr/bin/npm)" = /usr/lib/node_modules/npm/bin/npm-cli.js ]]
  [[ "$(readlink -f "$public_tooling/bin/npm")" = "$public_tooling/lib/node_modules/npm/bin/npm-cli.js" ]]
  /usr/bin/mount --bind "$public_tooling/bin/node" "$private_root/usr/bin/node"
  /usr/bin/mount -o remount,bind,ro "$private_root/usr/bin/node"
  /usr/bin/mount --rbind -o ro=recursive "$public_tooling/lib/node_modules/npm" "$private_root/usr/lib/node_modules/npm"
fi
/usr/bin/mount --bind "$lab_root/home" "$private_root$original_home"
/usr/bin/mount --bind "$lab_root" "$private_root$lab_root"
/usr/bin/mount --rbind -o ro=recursive "$host_modules" "$private_root/host-modules"
/usr/bin/mount --rbind -o ro=recursive "$host_objects" "$private_root$lab_root/git-objects"
/usr/bin/mount --bind "$lab_root/var-tmp" "$private_root/var/tmp"
/usr/bin/mount --bind "$lab_root/tmp" "$private_root/tmp"
/usr/bin/mount -t proc -o nosuid,nodev,noexec proc "$private_root/proc"
/usr/bin/mount -t proc -o ro,nosuid,nodev,noexec proc "$private_root/proc-reference"
for control in sys irq bus fs; do
  [[ -d "$private_root/proc/$control" ]]
  /usr/bin/mount --rbind -o ro=recursive "$private_root/proc/$control" "$private_root/proc/$control"
done
[[ -f "$private_root/proc/sysrq-trigger" ]]
/usr/bin/mount --bind "$private_root/proc/sysrq-trigger" "$private_root/proc/sysrq-trigger"
/usr/bin/mount -o remount,bind,ro "$private_root/proc/sysrq-trigger"
for device in null zero random urandom full; do
  touch "$private_root/dev/$device"
  /usr/bin/mount --bind "/dev/$device" "$private_root/dev/$device"
  /usr/bin/mount -o remount,bind,ro "$private_root/dev/$device"
done
ln -s /proc/self/fd "$private_root/dev/fd"
/usr/bin/ip link set lo up
export PM2_HOME="$HOME/.pm2" TMPDIR="$lab_root/tmp" WF_BASE="$lab_root/workflows" DATABASE_PATH="$lab_root/data/auth.db"
if [[ "$runtime_profile" = fleet-public-24.17-npm12 ]]; then
  mkdir -p "$lab_root/node/data" "$lab_root/node/app"
  export TMPDIR=/var/tmp DATABASE_PATH="$lab_root/node/data/auth.db" NASSAJ_UPDATE_LAB_ROOT="$lab_root"
fi
mkdir -m700 "$private_root/put_old"
# Exec closes the script descriptor before moving the mount namespace root.
exec /usr/bin/bash -euo pipefail -c '
  cd "$1"
  /usr/sbin/pivot_root . put_old
  exec /usr/sbin/chroot . /usr/bin/bash -euo pipefail -c '\''
  cd /
  /usr/bin/cat /proc/self/mountinfo > "$1/pivot-mountinfo-before-detach.txt"
  /usr/bin/python3 -c "import ctypes, os; libc=ctypes.CDLL(None,use_errno=True); result=libc.umount2(b\"/put_old\",2); result == 0 or (_ for _ in ()).throw(OSError(ctypes.get_errno(),os.strerror(ctypes.get_errno())))"
  /usr/bin/rmdir /put_old
  for descriptor in /proc/self/fd/*; do
    number=${descriptor##*/}
    [[ "$number" =~ ^[0-9]+$ ]] || exit 95
    if (( number > 2 )); then eval "exec ${number}>&-"; fi
  done
  /usr/bin/mount -o remount,bind,ro /
  cd "$1"
  exec /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all --no-new-privs \
    /usr/bin/node "$2"
  '\'' triple-inside "$2" "$3"
' triple-pivot "$private_root" "$lab_root" "$child_entry"
