#define _GNU_SOURCE
/* Local-forward build only. Independent from the B899 application-test launcher. */
#include <dirent.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/capability.h>
#include <linux/mount.h>
#include <linux/nsfs.h>
#include <linux/magic.h>
#include <net/if.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/statfs.h>
#include <sys/socket.h>
#include <sys/sysmacros.h>
#include <sys/syscall.h>
#include <unistd.h>

static void fail(const char *code) { perror(code); exit(78); }
static void private_namespace(const char *name, int user) {
  int fd = open(name, O_RDONLY | O_CLOEXEC), owner;
  struct stat expected, actual;
  if (fd < 0 || (owner = ioctl(fd, NS_GET_USERNS)) < 0
      || fstat(user, &expected) || fstat(owner, &actual)
      || expected.st_dev != actual.st_dev || expected.st_ino != actual.st_ino)
    fail("build_private_namespace_required");
  close(owner); close(fd);
}
static void require_private(const char *parent) {
  unsigned inside, outside, count; char extra, current[128];
  FILE *map = fopen("/proc/self/uid_map", "r");
  if (!map || fscanf(map, "%u %u %u %c", &inside, &outside, &count, &extra) != 3
      || count != 1 || inside != getuid() || outside != getuid() || getpid() != 1)
    fail("build_private_identity_required");
  fclose(map);
  ssize_t length = readlink("/proc/self/ns/mnt", current, sizeof(current) - 1);
  if (length <= 0 || length >= (ssize_t)sizeof(current) - 1) fail("build_namespace_read");
  current[length] = 0;
  if (!strcmp(parent, current)) fail("build_parent_namespace_retained");
  int user = open("/proc/self/ns/user", O_RDONLY | O_CLOEXEC);
  if (user < 0) fail("build_user_namespace");
  private_namespace("/proc/self/ns/mnt", user);
  private_namespace("/proc/self/ns/net", user);
  close(user);
}
static void join(char *out, const char *parent, const char *name) {
  if (snprintf(out, PATH_MAX, "%s/%s", parent, name) >= PATH_MAX) fail("build_path_limit");
}
struct pinned_path {char path[PATH_MAX]; int fd; struct stat info;};
static struct pinned_path pins[2048]; static unsigned pin_count;
static void check_pin(struct pinned_path *pin) {
  struct stat current, opened; char canonical[PATH_MAX];
  if (fstat(pin->fd, &opened) || lstat(pin->path, &current) || !realpath(pin->path, canonical)
      || strcmp(canonical,pin->path) || S_ISLNK(current.st_mode)
      || current.st_dev != pin->info.st_dev || current.st_ino != pin->info.st_ino
      || current.st_uid != pin->info.st_uid || current.st_mode != pin->info.st_mode
      || opened.st_dev != current.st_dev || opened.st_ino != current.st_ino)
    fail("build_mount_target_changed");
}
static struct pinned_path *pin_path(const char *file) {
  if (pin_count >= 2048) fail("build_mount_target_limit");
  struct pinned_path *pin=&pins[pin_count++];
  if (snprintf(pin->path,PATH_MAX,"%s",file)>=PATH_MAX) fail("build_mount_path_limit");
  pin->fd=open(file,O_PATH|O_NOFOLLOW|O_CLOEXEC);
  if(pin->fd<0 || fstat(pin->fd,&pin->info)
      || (!S_ISREG(pin->info.st_mode) && !S_ISDIR(pin->info.st_mode))
      || pin->info.st_uid!=getuid()) fail("build_mount_target_unsafe");
  check_pin(pin);return pin;
}
static void check_all_pins(void) {
  for(unsigned i=0;i<pin_count;i++)check_pin(&pins[i]);
}
static void attributes(const char *file, unsigned flags, unsigned long long set,
                       unsigned long long clear) {
  struct mount_attr attr = {.attr_set = set, .attr_clr = clear};
  struct pinned_path *pin=NULL;
  for(unsigned i=0;i<pin_count;i++)if(!strcmp(pins[i].path,file))pin=&pins[i];
  if(!pin)fail("build_unpinned_mount_attributes");
  check_pin(pin);
  if (syscall(SYS_mount_setattr, pin->fd, "", flags|AT_EMPTY_PATH, &attr, sizeof(attr))) fail("build_mount_attributes");
  check_pin(pin);
}
static void bind_path(const char *file) {
  struct pinned_path *pin=pin_path(file); char descriptor[64];
  snprintf(descriptor,sizeof(descriptor),"/proc/self/fd/%d",pin->fd);
  if (mount(descriptor, descriptor, NULL, MS_BIND, NULL)) fail("build_bind");
  check_pin(pin);
  close(pin->fd);pin->fd=open(file,O_PATH|O_NOFOLLOW|O_CLOEXEC);
  if(pin->fd<0)fail("build_bound_descriptor");
  check_pin(pin);
}
static void protected_inputs(const char *root) {
  char workspace[PATH_MAX]; join(workspace, root, "workspace"); bind_path(workspace);
  DIR *stream = opendir(workspace); if (!stream) fail("build_workspace_read");
  struct dirent *entry;
  while ((entry = readdir(stream))) {
    if (!strcmp(entry->d_name, ".") || !strcmp(entry->d_name, "..")) continue;
    char file[PATH_MAX]; struct stat info; join(file, workspace, entry->d_name);
    if (lstat(file, &info) || (!S_ISDIR(info.st_mode) && !S_ISREG(info.st_mode)))
      fail("build_input_root_type");
    bind_path(file);
  }
  closedir(stream);
}
static void drop_capabilities(void) {
  for (int cap = 0; cap <= CAP_LAST_CAP; cap++)
    if (prctl(PR_CAPBSET_DROP, cap, 0, 0, 0)) fail("build_drop_bounding_capability");
  if (prctl(PR_CAP_AMBIENT, PR_CAP_AMBIENT_CLEAR_ALL, 0, 0, 0)) fail("build_drop_ambient");
  struct __user_cap_header_struct header = {.version = _LINUX_CAPABILITY_VERSION_3, .pid = 0};
  struct __user_cap_data_struct data[2] = {{0}, {0}};
  if (syscall(SYS_capset, &header, data) || prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0))
    fail("build_drop_capabilities");
}
static void private_loopback(void) {
  int fd=socket(AF_INET,SOCK_DGRAM|SOCK_CLOEXEC,0);
  struct ifreq request={0};strcpy(request.ifr_name,"lo");
  if(fd<0 || ioctl(fd,SIOCGIFFLAGS,&request))fail("build_private_loopback_read");
  request.ifr_flags|=IFF_UP;
  if(ioctl(fd,SIOCSIFFLAGS,&request))fail("build_private_loopback_enable");
  close(fd);
}
int main(int argc, char **argv) {
  if (argc != 5) fail("build_arguments");
  require_private(argv[1]);
  private_loopback();
  char canonical[PATH_MAX]; struct stat info;
  if (!realpath(argv[2], canonical) || strcmp(argv[2], canonical)
      || lstat(canonical, &info) || !S_ISDIR(info.st_mode) || info.st_uid != getuid()
      || (info.st_mode & 0777) != 0700) fail("build_root_identity");
  for (int fd = 0; fd < 3; fd++) {
    if (fstat(fd, &info) || (!S_ISFIFO(info.st_mode) && !S_ISSOCK(info.st_mode)))
      fail("build_stdio_not_pipe");
  }
  if (mount(NULL, "/", NULL, MS_REC | MS_PRIVATE, NULL)) fail("build_mount_private");
  struct pinned_path *root_pin=pin_path(canonical);
  bind_path(canonical);
  check_pin(root_pin);close(root_pin->fd);
  root_pin->fd=open(canonical,O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(root_pin->fd<0)fail("build_bound_root_descriptor");
  check_pin(root_pin);protected_inputs(canonical);
  const char *writable[] = {"output", "scratch"};
  char file[PATH_MAX];
  for (unsigned i = 0; i < 2; i++) { join(file, canonical, writable[i]); bind_path(file); }
  const char *devices[] = {"null", "zero", "random", "urandom"};
  join(file,canonical,"dev");struct pinned_path *dev_pin=pin_path(file);
  join(file,canonical,"proc");struct pinned_path *proc_pin=pin_path(file);
  for (unsigned i = 0; i < 4; i++) {
    char source[PATH_MAX]; join(source, "/dev", devices[i]);
    char relative[64]; snprintf(relative, sizeof(relative), "dev/%s", devices[i]);
    join(file, canonical, relative);
    struct pinned_path *target=pin_path(file);struct stat device,observed;
    int source_fd=open(source,O_PATH|O_NOFOLLOW|O_CLOEXEC);
    unsigned minors[]={3,5,8,9};
    if(source_fd<0 || fstat(source_fd,&device) || !S_ISCHR(device.st_mode)
        || major(device.st_rdev)!=1 || minor(device.st_rdev)!=minors[i])fail("build_device_source");
    char source_name[64],target_name[64];
    snprintf(source_name,sizeof(source_name),"/proc/self/fd/%d",source_fd);
    snprintf(target_name,sizeof(target_name),"/proc/self/fd/%d",target->fd);
    if (mount(source_name, target_name, NULL, MS_BIND, NULL)) fail("build_device_bind");
    check_pin(dev_pin);close(target->fd);
    target->fd=openat(dev_pin->fd,devices[i],O_PATH|O_NOFOLLOW|O_CLOEXEC);
    if(target->fd<0 || fstat(target->fd,&observed) || !S_ISCHR(observed.st_mode)
        || observed.st_dev!=device.st_dev || observed.st_ino!=device.st_ino
        || observed.st_rdev!=device.st_rdev)fail("build_device_target_identity");
    target->info=observed;check_pin(target);close(source_fd);
  }
  join(file, canonical, "proc");
  char proc_name[64];snprintf(proc_name,sizeof(proc_name),"/proc/self/fd/%d",proc_pin->fd);
  if (mount("proc", proc_name, "proc", MS_NOSUID | MS_NODEV | MS_NOEXEC | MS_RDONLY, NULL)) fail("build_private_proc");
  check_pin(root_pin);
  close(proc_pin->fd);proc_pin->fd=openat(root_pin->fd,"proc",O_PATH|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
  if(proc_pin->fd<0 || fstat(proc_pin->fd,&proc_pin->info))fail("build_private_proc_identity");
  struct statfs proc_fs;char self[32];ssize_t self_length=readlinkat(proc_pin->fd,"self",self,sizeof(self));
  if(fstatfs(proc_pin->fd,&proc_fs) || proc_fs.f_type!=PROC_SUPER_MAGIC || self_length!=1 || self[0]!='1')fail("build_private_proc_view");
  check_pin(proc_pin);
  attributes(canonical, AT_RECURSIVE, MOUNT_ATTR_RDONLY | MOUNT_ATTR_NOSUID, 0);
  for (unsigned i = 0; i < 2; i++) { join(file, canonical, writable[i]); attributes(file, 0, 0, MOUNT_ATTR_RDONLY); }
  join(file, canonical, "workspace"); attributes(file, 0, 0, MOUNT_ATTR_RDONLY);
  check_all_pins();
  if (fchdir(root_pin->fd)) fail("build_root_fchdir");
  check_all_pins();
  if (chroot(".") || chdir("/workspace")) fail("build_chroot");
  if (syscall(SYS_close_range, 3u, ~0u, 0u)) fail("build_close_descriptors");
  drop_capabilities();
  char *args[] = {"/usr/bin/node", "/workspace/scripts/build-local-forward-artifacts.mjs", "--inside", argv[3], argv[4], NULL};
  execv(args[0], args); fail("build_exec");
}
