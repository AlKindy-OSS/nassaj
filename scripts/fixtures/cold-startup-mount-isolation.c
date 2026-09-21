#define _GNU_SOURCE
/* Test-only mount confinement. No fallback and no mount before namespace checks. */
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
      || count != 1 || inside != getuid() || outside != getuid()) {
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
    if (prctl(PR_CAPBSET_DROP, capability, 0, 0, 0)) fail("drop_bounding_capability");
  }
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail("drop_ambient_capabilities");
  struct __user_cap_header_struct header = { .version = _LINUX_CAPABILITY_VERSION_3, .pid = 0 };
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, data)) fail("drop_process_capabilities");
  if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0)) fail("no_new_privileges");
}
int main(int argc, char **argv) {
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
  if (syscall(SYS_close_range, 3u, ~0u, 0u)) fail("close_inherited_descriptors");
  drop_capabilities();
  deny_host_unix_sockets();
  execv(argv[3], &argv[3]); fail("exec_probe");
}
