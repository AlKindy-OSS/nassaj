#define _GNU_SOURCE
/* Test-only derivative of B899: identical mount/IPC confinement, retaining only
 * CAP_NET_ADMIN in a kernel-proven private network namespace for nft integration.
 * One UID mapping only: separate inner 0/1000/1001 runs map to the invoking
 * unprivileged host UID. Never map multiple host identities. */
#ifndef NASSAJ_TEST_HOST_UID
#error "Compile with measured non-root host UID"
#endif
#include <errno.h>
#include <dirent.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/audit.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <net/if.h>
#include <stddef.h>
#include <sys/socket.h>
#include <linux/mount.h>
#include <linux/nsfs.h>
#include <sys/ioctl.h>
#include <sys/stat.h>
#include <sys/statvfs.h>
#include <sys/wait.h>
#include <sched.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(const char *operation) { perror(operation); exit(78); }
static void namespace_name(const char *file, char *buffer) {
  ssize_t size = readlink(file, buffer, 127);
  if (size < 0 || size >= 127) fail("namespace_read");
  buffer[size] = 0;
}
static void require_private(void) {
  unsigned inside, outside, count; char extra;
  FILE *map = fopen("/proc/self/uid_map", "r");
  if (!map || fscanf(map, "%u %u %u %c", &inside, &outside, &count, &extra) != 3
      || count != 1 || inside != getuid() || outside != NASSAJ_TEST_HOST_UID
      || NASSAJ_TEST_HOST_UID == 0 || (inside != 0 && inside != 1000 && inside != 1001)) {
    errno = EPERM; fail("private_single_uid_map_required");
  }
  fclose(map);
  int mount_ns = open("/proc/self/ns/mnt", O_RDONLY | O_CLOEXEC);
  int user_ns = open("/proc/self/ns/user", O_RDONLY | O_CLOEXEC);
  int owner = ioctl(mount_ns, NS_GET_USERNS);
  struct stat expected, observed;
  if (mount_ns < 0 || user_ns < 0 || owner < 0 || fstat(user_ns, &expected) || fstat(owner, &observed)
      || expected.st_dev != observed.st_dev || expected.st_ino != observed.st_ino) {
    errno = EPERM; fail("mount_namespace_not_owned_by_private_user_namespace");
  }
  close(owner); close(mount_ns);
  int network_ns = open("/proc/self/ns/net", O_RDONLY | O_CLOEXEC);
  owner = ioctl(network_ns, NS_GET_USERNS);
  if (network_ns < 0 || owner < 0 || fstat(owner, &observed)
      || expected.st_dev != observed.st_dev || expected.st_ino != observed.st_ino) {
    errno = EPERM; fail("network_namespace_not_owned_by_private_user_namespace");
  }
  close(owner); close(network_ns); close(user_ns);
}
static void require_owned_tree(const char *directory) {
  DIR *stream = opendir(directory); if (!stream) fail("fixture_directory_read");
  struct dirent *entry;
  while ((entry = readdir(stream))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    char file[PATH_MAX];
    if (snprintf(file, sizeof(file), "%s/%s", directory, entry->d_name) >= (int)sizeof(file)) fail("fixture_path_too_long");
    struct stat metadata; if (lstat(file, &metadata)) fail("fixture_metadata");
    if (metadata.st_uid != getuid() || (!S_ISDIR(metadata.st_mode) && !S_ISREG(metadata.st_mode))
        || (S_ISREG(metadata.st_mode) && metadata.st_nlink != 1)) {
      errno = EPERM; fail("fixture_external_alias_or_special_file");
    }
    if (S_ISDIR(metadata.st_mode)) require_owned_tree(file);
  }
  closedir(stream);
}
static void attributes(const char *file, unsigned flags, unsigned long long set, unsigned long long clear) {
  struct mount_attr attr = {.attr_set = set, .attr_clr = clear};
  if (syscall(SYS_mount_setattr, AT_FDCWD, file, flags, &attr, sizeof(attr))) fail("mount_setattr");
}
static void enable_private_loopback(void) {
  int fd = socket(AF_INET, SOCK_DGRAM | SOCK_CLOEXEC, 0);
  if (fd < 0) fail("loopback_socket");
  struct ifreq request = {0}; strcpy(request.ifr_name, "lo");
  if (ioctl(fd, SIOCGIFFLAGS, &request)) fail("loopback_flags_read");
  request.ifr_flags |= IFF_UP;
  if (ioctl(fd, SIOCSIFFLAGS, &request)) fail("loopback_enable");
  close(fd);
}
static void deny_host_unix_sockets(void) {
#if !defined(__x86_64__)
#error "Fixture seccomp architecture requires a reviewed native architecture mapping"
#endif
  struct sock_filter filter[] = {
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
    /* io_uring socket/connect operations bypass socket syscall filters. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_setup, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_enter, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_io_uring_register, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    /* Reject x32 ABI rather than exposing a second unchecked socket syscall. */
    BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socket, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 0, 1),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    /* Connected stream pairs support subprocess pipes. Datagram pairs could reconnect to host paths. */
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SYS_socketpair, 0, 4),
    BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[1])),
    BPF_STMT(BPF_ALU | BPF_AND | BPF_K, ~(SOCK_CLOEXEC | SOCK_NONBLOCK)),
    BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, SOCK_STREAM, 1, 0),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
    BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
  };
  struct sock_fprog program = {.len = sizeof(filter) / sizeof(filter[0]), .filter = filter};
  if (prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) fail("unix_socket_seccomp");
}
static void drop_capabilities(void) {
  for (int capability = 0; capability <= CAP_LAST_CAP; capability++) {
    if (capability != CAP_NET_ADMIN && prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)) fail("drop_bounding_capability");
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail("drop_ambient_capabilities");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  data[0].effective = data[0].permitted = data[0].inheritable = 1u << CAP_NET_ADMIN;
  if (syscall(SYS_capset, &header, data)) fail("drop_process_capabilities");
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_RAISE, CAP_NET_ADMIN, 0, 0)) fail("private_net_admin_ambient");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privileges");
}
/* Topology exists only after private mount/net ownership and read-only confinement.
 * The peer is a child in our private PID namespace; no host netns descriptor is used. */
static void ip_command(char **arguments) {
  pid_t child = fork(); if (child < 0) fail("ip_fork");
  if (!child) { execv("/usr/sbin/ip", arguments); fail("ip_exec"); }
  int status; if (waitpid(child, &status, 0) != child || !WIFEXITED(status) || WEXITSTATUS(status)) { errno = EPERM; fail("private_ip_configuration"); }
}
static void configure_private_peer(int argc, char **argv) {
  if (argc < 8) { errno = EINVAL; fail("peer_fixture_arguments"); }
  int ready[2], go[2]; if (pipe2(ready, O_CLOEXEC) || pipe2(go, O_CLOEXEC)) fail("peer_pipes");
  pid_t peer = fork(); if (peer < 0) fail("peer_fork");
  if (!peer) {
    close(ready[0]); close(go[1]);
    if (unshare(CLONE_NEWNET)) fail("private_peer_network");
    require_private();
    if (write(ready[1], "r", 1) != 1) fail("peer_ready");
    close(ready[1]);
    char byte; if (read(go[0], &byte, 1) != 1 || byte != 'g') fail("peer_go"); close(go[0]);
    enable_private_loopback();
    char *address[] = {"ip", "address", "add", "10.203.0.2/30", "dev", "ff-peer", NULL}; ip_command(address);
    char *up[] = {"ip", "link", "set", "ff-peer", "up", NULL}; ip_command(up);
    if (syscall(SYS_close_range, 3u, ~0u, 0u)) fail("peer_close_descriptors");
    drop_capabilities(); deny_host_unix_sockets();
    /* Re-enter our checked probe mode to remove NET_ADMIN before Node/HTTP. */
    char *arguments[] = {argv[6], "--drop-net-admin", argv[3], argv[4], "peer", argv[6], argv[7], NULL};
    execv(argv[6], arguments); fail("peer_exec");
  }
  close(ready[1]); close(go[0]);
  char byte; if (read(ready[0], &byte, 1) != 1 || byte != 'r') fail("parent_peer_ready"); close(ready[0]);
  char peer_pid[32]; if (snprintf(peer_pid, sizeof(peer_pid), "%d", peer) < 1) fail("peer_pid");
  char *pair[] = {"ip", "link", "add", "ff-main", "type", "veth", "peer", "name", "ff-peer", NULL}; ip_command(pair);
  char *move[] = {"ip", "link", "set", "ff-peer", "netns", peer_pid, NULL}; ip_command(move);
  char *address[] = {"ip", "address", "add", "10.203.0.1/30", "dev", "ff-main", NULL}; ip_command(address);
  char *up[] = {"ip", "link", "set", "ff-main", "up", NULL}; ip_command(up);
  if (write(go[1], "g", 1) != 1) fail("parent_peer_go");
  close(go[1]);
}
static void run_unprivileged_probe(int argc, char **argv) {
  if (argc < 3 || prctl(PR_GET_NO_NEW_PRIVS, 0, 0, 0, 0) != 1) { errno = EPERM; fail("probe_requires_confinement"); }
  require_private();
  struct statvfs root_mount;
  if (prctl(PR_GET_SECCOMP, 0, 0, 0, 0) != SECCOMP_MODE_FILTER || statvfs("/", &root_mount) || !(root_mount.f_flag & ST_RDONLY)) {
    errno = EPERM; fail("probe_requires_readonly_seccomp");
  }
  if (syscall(SYS_close_range, 3u, ~0u, 0u)) fail("probe_close_descriptors");
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail("probe_drop_ambient");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, data)) fail("probe_drop_capabilities");
  execv(argv[2], &argv[2]); fail("exec_unprivileged_probe");
}
int main(int argc, char **argv) {
  if (argc >= 2 && !strcmp(argv[1], "--drop-net-admin")) run_unprivileged_probe(argc, argv);
  if (argc < 4 || getpid() != 1) { errno = EPERM; fail("private_pid_namespace_required"); }
  require_private();
  for (int fd = 0; fd < 3; fd++) {
    struct stat metadata;
    if (fstat(fd, &metadata) || (!S_ISFIFO(metadata.st_mode) && !S_ISSOCK(metadata.st_mode))) {
      errno = EPERM; fail("stdio_must_be_pipes_or_sockets");
    }
    if (S_ISSOCK(metadata.st_mode)) {
      int kind; socklen_t length = sizeof(kind);
      if (getsockopt(fd, SOL_SOCKET, SO_TYPE, &kind, &length) || kind != SOCK_STREAM) {
        errno = EPERM; fail("stdio_socket_must_be_connected_stream");
      }
    }
  }
  char current[128], canonical[PATH_MAX]; namespace_name("/proc/self/ns/mnt", current);
  if (!strcmp(current, argv[1])) { errno = EPERM; fail("parent_mount_namespace_retained"); }
  if (!realpath(argv[2], canonical) || strcmp(canonical, argv[2])) fail("fixture_path_not_canonical");
  require_owned_tree(argv[2]);
  enable_private_loopback();
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) fail("mount_private");
  if (mount(argv[2], argv[2], NULL, MS_BIND, NULL)) fail("fixture_bind");
  if (mount("proc", "/proc", "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC, NULL)) fail("private_proc");
  attributes("/", AT_RECURSIVE, MOUNT_ATTR_RDONLY, 0);
  attributes(argv[2], 0, 0, MOUNT_ATTR_RDONLY);
  if (chdir(argv[2])) fail("fixture_cwd");
  if (syscall(SYS_close_range, 3u, ~0u, 0u)) fail("close_before_peer_setup");
  configure_private_peer(argc, argv);
  if (syscall(SYS_close_range, 3u, ~0u, 0u)) fail("close_inherited_descriptors");
  drop_capabilities();
  deny_host_unix_sockets();
  execv(argv[3], &argv[3]); fail("exec_probe");
}
