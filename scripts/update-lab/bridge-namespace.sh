#!/usr/bin/env bash
# ADR-160: entered only through unshare; host services and HOME stay untouched.
set -euo pipefail
lab_root=$1
host_home=$2
host_modules=$3
child_entry=$4
host_objects=$5
[[ "$lab_root" = /*/.artifacts/t1772-bridge-rehearsal/* ]]
[[ "$(readlink -f "$lab_root")" = "$lab_root" ]]
[[ "$HOME" = "$host_home" && "$host_home" = /home/* ]]
[[ "$child_entry" = "$lab_root"/harness/* ]]
[[ "$(readlink /proc/self/ns/user)" != "$NASSAJ_LAB_PARENT_USER_NS" ]]
[[ "$(readlink /proc/self/ns/mnt)" != "$NASSAJ_LAB_PARENT_MOUNT_NS" ]]
[[ "$(readlink /proc/self/ns/net)" != "$NASSAJ_LAB_PARENT_NET_NS" ]]
[[ "$(readlink /proc/self/ns/pid)" != "$NASSAJ_LAB_PARENT_PID_NS" ]]
exec {lab_fd}<"$lab_root"
exec {modules_fd}<"$host_modules"
exec {objects_fd}<"$host_objects"
/usr/bin/mount --make-rprivate /
# All backing directories were created inside the project-owned scratch first.
/usr/bin/mount --bind "$lab_root/home" "$host_home"
/usr/bin/mount --no-canonicalize --bind "/proc/self/fd/$lab_fd" "$lab_root"
/usr/bin/mount --no-canonicalize --bind "/proc/self/fd/$modules_fd" "$lab_root/app/node_modules"
/usr/bin/mount --no-canonicalize --bind "/proc/self/fd/$objects_fd" "$lab_root/git-objects"
for hidden in /run /tmp /root /sys /var/lib/docker; do
  /usr/bin/mount --bind "$lab_root/empty" "$hidden"
done
for device in null zero random urandom full; do
  /usr/bin/mount --bind "/dev/$device" "$lab_root/dev/$device"
done
/usr/bin/mount --rbind "$lab_root/dev" /dev
/usr/bin/mount --bind "$lab_root/var-tmp" /var/tmp
# Recursive bind is required for locked inherited submounts in a user namespace.
/usr/bin/mount --rbind -o ro=recursive / /
/usr/bin/mount -o remount,bind,rw "$lab_root"
/usr/bin/mount -o remount,bind,rw "$host_home"
/usr/bin/mount -o remount,bind,rw /var/tmp
/usr/bin/mount -o remount,bind,ro "$lab_root/app/node_modules"
/usr/bin/mount -o remount,bind,ro "$lab_root/git-objects"
for hidden in /run /tmp /root /sys /var/lib/docker; do
  /usr/bin/mount -o remount,bind,ro "$hidden"
done
/usr/bin/mount -o remount,bind,ro /dev
/usr/bin/mount -o remount,bind,ro /proc
/usr/bin/ip link set lo up
exec {modules_fd}<&-
exec {objects_fd}<&-
exec {lab_fd}<&-
cd "$lab_root"
export PM2_HOME="$HOME/.pm2"
export TMPDIR="$lab_root/tmp"
export WF_BASE="$lab_root/workflows"
export DATABASE_PATH="$lab_root/data/auth.db"
# The application cannot remount a host-backed path or escape the PID namespace.
exec /usr/bin/setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all \
  /usr/bin/node "$child_entry"
