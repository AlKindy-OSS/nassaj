#!/usr/bin/python3
"""Reviewed namespace setup only; execute target code after permanent privilege drop."""
import ctypes
import hashlib
import json
import os
import re
import signal
import select
import stat
import subprocess
import sys
import time

PROJECT = '/home/operator/Project/nassaj-dev'
BASE = PROJECT + '/.artifacts/t1772-bridge-rehearsal'
NOFOLLOW = os.O_NOFOLLOW | os.O_CLOEXEC
DIRECTORY = os.O_RDONLY | os.O_DIRECTORY | NOFOLLOW
CAPTURE = ('user', 'mnt', 'net', 'pid')
DIAGNOSTIC = {'role': 'operator', 'stage': 'arguments', 'operation': None}


def stage(name):
    """Record the current fixed setup stage without input-derived text."""
    DIAGNOSTIC['stage'] = name
    DIAGNOSTIC['operation'] = None


def report_failure(error):
    """Emit bounded operational facts only, never command arguments or exception text."""
    names = {'RuntimeError', 'OSError', 'PermissionError', 'FileNotFoundError', 'CalledProcessError',
             'TimeoutExpired', 'AssertionError', 'ValueError', 'JSONDecodeError', 'ChildProcessError'}
    name = type(error).__name__
    result = {'schema': 'nassaj-root-lab-diagnostic/v1', 'state': 'failed', **DIAGNOSTIC,
              'exceptionType': name if name in names else 'OtherError'}
    if isinstance(error, OSError) and isinstance(error.errno, int):
        result['errno'] = error.errno
    if isinstance(error, subprocess.CalledProcessError):
        result['exitCode'] = error.returncode
    if isinstance(error, RuntimeError) and re.fullmatch(r'root_lab_[a-z_]{1,80}', str(error)):
        result['code'] = str(error)
    print(json.dumps(result), file=sys.stderr, flush=True)

def require(ok, reason):
    """Reject an invalid invariant using a fixed, non-sensitive reason code."""
    if not ok:
        raise RuntimeError('root_lab_' + reason)


def open_directory(value):
    """Resolve every component without following symlinks, retaining the final inode."""
    require(value.startswith('/') and os.path.normpath(value) == value, 'path')
    fd = os.open('/', DIRECTORY)
    try:
        for component in value.split('/')[1:]:
            next_fd = os.open(component, DIRECTORY, dir_fd=fd)
            os.close(fd)
            fd = next_fd
        return fd
    except BaseException:
        os.close(fd)
        raise


def read_pinned(directory, name, expected, uid, limit=2 * 1024 * 1024):
    """Read one bounded regular file after validating identity and pinned bytes."""
    require(re.fullmatch(r'[A-Za-z0-9_.-]+', name) is not None, 'filename')
    fd = os.open(name, os.O_RDONLY | os.O_NONBLOCK | NOFOLLOW, dir_fd=directory)
    try:
        before = os.fstat(fd)
        require(stat.S_ISREG(before.st_mode) and before.st_nlink == 1 and before.st_uid == uid
                and not before.st_mode & 0o022 and before.st_size <= limit, 'input_metadata')
        data = b''
        while True:
            piece = os.read(fd, min(65536, limit + 1 - len(data)))
            if not piece:
                break
            data += piece
            require(len(data) <= limit, 'input_size')
        after = os.fstat(fd)
        require((before.st_dev, before.st_ino, before.st_size, before.st_ctime_ns)
                == (after.st_dev, after.st_ino, after.st_size, after.st_ctime_ns), 'input_changed')
        require(hashlib.sha256(data).hexdigest() == expected, 'input_digest')
        return data
    finally:
        os.close(fd)


def inspect(run, expected):
    """Read-only package validation; callable unprivileged for rejection tests."""
    require(os.path.dirname(run) == BASE and re.fullmatch(r'run-[A-Za-z0-9_]+', os.path.basename(run)), 'run_scope')
    require(re.fullmatch(r'[a-f0-9]{64}', expected) is not None, 'package_digest')
    run_fd = open_directory(run)
    owned = [run_fd]
    try:
        info = os.fstat(run_fd)
        require(info.st_uid == 1000 and info.st_gid == 1000 and stat.S_IMODE(info.st_mode) == 0o700, 'run_owner')
        package = json.loads(read_pinned(run_fd, 'root-lab-package.json', expected, 1000))
        require(set(package) == {'schema', 'run', 'uid', 'gid', 'files', 'timeoutSeconds'}, 'package_schema')
        require(package['schema'] == 'nassaj-service-owner-root-lab/v1' and package['run'] == run
                and package['uid'] == 1000 and package['gid'] == 1000 and package['timeoutSeconds'] == 90, 'package_scope')
        require(set(package['files']) == {'service-owner-probe.mjs', 'capsule.mjs', 'idle.mjs'}, 'package_files')
        for name in ('harness', 'home', 'tmp', 'var-tmp'):
            fd = os.open(name, DIRECTORY, dir_fd=run_fd)
            owned.append(fd)
            item = os.fstat(fd)
            require(item.st_uid == 1000 and stat.S_IMODE(item.st_mode) == 0o700, 'fixture_owner')
        for fd in owned[2:]:
            require(not os.listdir(fd), 'fixture_not_empty')
        require(not set(os.listdir(run_fd)) & {'app', 'ecosystem.config.cjs', 'service-owner-probe.json', 'rootfs'}, 'previous_effects')
        for name, digest in package['files'].items():
            read_pinned(owned[1], name, digest, 1000)
        require(os.statvfs(run).f_bavail * os.statvfs(run).f_frsize >= 16 * 1024**3, 'capacity')
        return package, owned
    except BaseException:
        for fd in owned:
            os.close(fd)
        raise


def mkdir_tree(root, value):
    """Create only root-owned directories below a held root descriptor."""
    current = os.dup(root)
    try:
        for part in value.strip('/').split('/'):
            require(part not in ('', '.', '..'), 'directory_segment')
            try:
                os.mkdir(part, 0o755, dir_fd=current)
            except FileExistsError:
                pass
            following = os.open(part, DIRECTORY, dir_fd=current)
            metadata = os.fstat(following)
            require(metadata.st_uid == 0 and not metadata.st_mode & 0o022, 'root_directory')
            os.fchmod(following, 0o755)
            os.close(current)
            current = following
        return current
    except BaseException:
        os.close(current)
        raise


def tool(*args, fds=()):
    """Run a fixed setup tool with bounded time and redacted failure diagnostics."""
    DIAGNOSTIC['operation'] = os.path.basename(args[0])
    subprocess.run(args, check=True, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL,
                   stderr=subprocess.DEVNULL, env={'PATH': '/usr/bin:/usr/sbin', 'LANG': 'C'},
                   pass_fds=tuple(fds), timeout=10)
    DIAGNOSTIC['operation'] = None


def bind(source_fd, target_fd, readonly=False, recursive=False):
    """Bind descriptor-pinned inputs inside the already private mount namespace."""
    libc = ctypes.CDLL(None, use_errno=True)
    # Clone before attaching: readonly applies to this detached tree, never its source.
    flags = 0x1000 | (0x8000 if recursive else 0)  # AT_EMPTY_PATH / AT_RECURSIVE
    DIAGNOSTIC['operation'] = 'open_tree'
    tree = libc.open_tree(source_fd, b'', flags | 1 | os.O_CLOEXEC)
    if tree < 0:
        raise OSError(ctypes.get_errno(), 'open tree failed')
    try:
        if readonly:
            DIAGNOSTIC['operation'] = 'mount_setattr'
            attributes = (ctypes.c_uint64 * 4)(1, 0, 0, 0)  # MOUNT_ATTR_RDONLY; no flags cleared
            if libc.mount_setattr(tree, b'', flags, ctypes.byref(attributes), ctypes.sizeof(attributes)) != 0:
                raise OSError(ctypes.get_errno(), 'mount attributes failed')
        DIAGNOSTIC['operation'] = 'move_mount'
        if libc.move_mount(tree, b'', target_fd, b'', 0x04 | 0x40) != 0:
            raise OSError(ctypes.get_errno(), 'move mount failed')
    finally:
        os.close(tree)
    DIAGNOSTIC['operation'] = None


def mount_proc(target_fd):
    """Mount private procfs using its pinned target, with no userspace path resolution."""
    libc = ctypes.CDLL(None, use_errno=True)
    DIAGNOSTIC['operation'] = 'mount_proc'
    target = ('/proc/self/fd/' + str(target_fd)).encode('ascii')
    if libc.mount(b'proc', target, b'proc', 2 | 4 | 8, None) != 0:  # nosuid,nodev,noexec
        raise OSError(ctypes.get_errno(), 'proc mount failed')
    DIAGNOSTIC['operation'] = None


def namespace_directories(package, owned):
    """Reopen inspected inodes in this mount namespace, refusing any path rebinding."""
    reopened = []
    try:
        run = open_directory(package['run'])
        reopened.append(run)
        for name in ('harness', 'home', 'tmp', 'var-tmp'):
            reopened.append(os.open(name, DIRECTORY, dir_fd=run))
        require(len(reopened) == len(owned), 'namespace_descriptors')
        for previous, current in zip(owned, reopened):
            before, after = os.fstat(previous), os.fstat(current)
            require((before.st_dev, before.st_ino, before.st_uid, before.st_gid, before.st_mode)
                    == (after.st_dev, after.st_ino, after.st_uid, after.st_gid, after.st_mode),
                    'namespace_directory_rebound')
            require(after.st_uid == 1000 and stat.S_IMODE(after.st_mode) == 0o700,
                    'namespace_directory_metadata')
        require(os.fstat(run).st_gid == 1000, 'namespace_run_group')
        return reopened
    except BaseException:
        for fd in reopened:
            os.close(fd)
        raise


def mount_identity(fd):
    """Read the kernel mount ID for a held directory without resolving its path."""
    with open('/proc/self/fdinfo/' + str(fd), encoding='ascii') as stream:
        match = re.search(r'^mnt_id:\s+(\d+)$', stream.read(), re.M)
    require(match is not None, 'mount_identity')
    return int(match.group(1))


def root_setup(package, owned, parent_ns, parent_fd):
    """Private mounts; no supplied executable or application byte runs with privilege."""
    stage('repin_namespace_directories')
    owned = namespace_directories(package, owned)
    stage('rootfs_prepare')
    run_fd = owned[0]
    for fd in owned[2:]:
        require(not os.listdir(fd), 'fixture_not_empty')
    os.mkdir('rootfs', 0o700, dir_fd=run_fd)
    root_fd = os.open('rootfs', DIRECTORY, dir_fd=run_fd)
    original = os.fstat(root_fd)
    original_mount = mount_identity(root_fd)
    require(original.st_uid == 0 and original.st_gid == 0 and stat.S_IMODE(original.st_mode) == 0o700, 'rootfs_owner')
    bind(root_fd, root_fd)
    mounted = os.open('rootfs', DIRECTORY, dir_fd=run_fd)
    observed = os.fstat(mounted)
    require((original.st_dev, original.st_ino) == (observed.st_dev, observed.st_ino), 'rootfs_rebound')
    require(mount_identity(mounted) != original_mount, 'rootfs_not_mounted')
    os.close(root_fd)
    root_fd = mounted
    for name in ('usr', 'proc', 'dev', 'etc', 'put_old', 'reviewed-harness'):
        os.close(mkdir_tree(root_fd, name))
    stage('freeze_harness')
    frozen = os.open('reviewed-harness', DIRECTORY, dir_fd=root_fd)
    for name, digest in package['files'].items():
        data = read_pinned(owned[1], name, digest, 1000)
        output = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | NOFOLLOW, 0o444, dir_fd=frozen)
        try:
            os.fchmod(output, 0o444)
            with os.fdopen(output, 'wb', closefd=False) as stream:
                stream.write(data)
                stream.flush()
                os.fsync(output)
        finally:
            os.close(output)
    os.close(frozen)
    for name in ('lib', 'lib64', 'bin', 'sbin'):
        target = os.readlink('/' + name)
        require(not target.startswith('/') and '..' not in target.split('/'), 'system_link')
        os.symlink(target, name, dir_fd=root_fd)
    stage('bind_usr')
    usr = open_directory('/usr')
    destination = os.open('usr', DIRECTORY, dir_fd=root_fd)
    bind(usr, destination, True, True)
    os.close(usr)
    os.close(destination)
    stage('bind_fixtures')
    for source, target in [(run_fd, '/lab'), (owned[2], '/home/operator'),
                           (owned[3], '/tmp'), (owned[4], '/var/tmp')]:
        destination = mkdir_tree(root_fd, target)
        bind(source, destination)
        os.close(destination)
    stage('prepare_etc')
    etc = os.open('etc', DIRECTORY, dir_fd=root_fd)
    for name, data in [('passwd', b'root:x:0:0:root:/root:/usr/bin/bash\noperator:x:1000:1000:lab:/home/operator:/usr/bin/bash\n'),
                       ('group', b'root:x:0:\noperator:x:1000:\n'), ('nsswitch.conf', b'passwd: files\ngroup: files\nhosts: files\n'),
                       ('hosts', b'127.0.0.1 localhost\n')]:
        output = os.open(name, os.O_CREAT | os.O_EXCL | os.O_WRONLY | NOFOLLOW, 0o644, dir_fd=etc)
        os.fchmod(output, 0o644)
        os.write(output, data)
        os.close(output)
    alternatives = mkdir_tree(root_fd, 'etc/alternatives')
    require(os.readlink('/etc/alternatives/which') == '/usr/bin/which.debianutils', 'which_identity')
    os.symlink('/usr/bin/which.debianutils', 'which', dir_fd=alternatives)
    os.close(alternatives)
    source = os.open('/etc/ld.so.cache', os.O_RDONLY | NOFOLLOW)
    target = os.open('ld.so.cache', os.O_CREAT | os.O_EXCL | os.O_RDWR | NOFOLLOW, 0o644, dir_fd=etc)
    bind(source, target, True)
    os.close(source)
    os.close(target)
    os.close(etc)
    stage('mount_proc')
    proc = os.open('proc', DIRECTORY, dir_fd=root_fd)
    mount_proc(proc)
    os.close(proc)
    stage('bind_devices')
    dev = os.open('dev', DIRECTORY, dir_fd=root_fd)
    for name in ('null', 'zero', 'random', 'urandom', 'full'):
        source = os.open('/dev/' + name, os.O_RDONLY | NOFOLLOW)
        target = os.open(name, os.O_CREAT | os.O_EXCL | os.O_RDWR | NOFOLLOW, 0o644, dir_fd=dev)
        bind(source, target, True)
        os.close(source)
        os.close(target)
    os.symlink('/proc/self/fd', 'fd', dir_fd=dev)
    os.close(dev)
    stage('network_loopback')
    tool('/usr/bin/ip', 'link', 'set', 'lo', 'up')
    stage('pivot_root')
    os.fchdir(root_fd)
    libc = ctypes.CDLL(None, use_errno=True)
    if libc.pivot_root(b'.', b'put_old') != 0:
        raise OSError(ctypes.get_errno(), 'pivot failed')
    os.chroot('.')
    os.chdir('/')
    os.fchmod(root_fd, 0o755)
    stage('detach_old_root')
    if libc.umount2(b'/put_old', 2) != 0:
        raise OSError(ctypes.get_errno(), 'detach failed')
    os.rmdir('/put_old')
    for fd in list(map(int, os.listdir('/proc/self/fd'))):
        if fd > 2 and fd != parent_fd:
            try:
                os.close(fd)
            except OSError:
                pass
    environment = {'PATH': '/usr/bin:/usr/sbin', 'HOME': '/home/operator', 'LANG': 'C.UTF-8',
                   'PM2_HOME': '/home/operator/.pm2', 'TMPDIR': '/var/tmp',
                   'NASSAJ_LAB_PARENT_NAMESPACES': json.dumps(parent_ns), 'NASSAJ_LAB_ROOT': '/lab'}
    os.chdir('/lab')
    stage('drop_authority')
    drop_authority(parent_fd)
    os.close(parent_fd)
    stage('exec_probe')
    os.execve('/usr/bin/node', ['node', '/reviewed-harness/service-owner-probe.mjs'], environment)


def bind_parent_death(parent_fd):
    """Set the kernel death signal, then close the pre-registration parent-death race."""
    libc = ctypes.CDLL(None, use_errno=True)
    require(libc.prctl(1, signal.SIGKILL, 0, 0, 0) == 0, 'parent_death_signal')
    poll = select.poll()
    poll.register(parent_fd, select.POLLIN)
    require(not poll.poll(0), 'parent_already_dead')


def drop_authority(parent_fd):
    """Drop credentials/capabilities permanently, then rebind PDEATHSIG cleared by setuid."""
    libc = ctypes.CDLL(None, use_errno=True)
    last = int(open('/proc/sys/kernel/cap_last_cap', encoding='ascii').read())
    require(0 <= last <= 63, 'capability_range')
    require(libc.prctl(47, 4, 0, 0, 0) == 0, 'ambient_clear')
    for capability in range(last + 1):
        require(libc.prctl(24, capability, 0, 0, 0) == 0, 'bounding_clear')
    os.setgroups([])
    os.setresgid(1000, 1000, 1000)
    os.setresuid(1000, 1000, 1000)
    require(libc.prctl(38, 1, 0, 0, 0) == 0, 'no_new_privileges')
    bind_parent_death(parent_fd)
    status = open('/proc/self/status', encoding='ascii').read()
    for key in ('CapInh', 'CapPrm', 'CapEff', 'CapBnd', 'CapAmb'):
        require(re.search(r'^' + key + r':\s+0+$', status, re.M), 'remaining_capability')
    require(os.getresuid() == (1000, 1000, 1000) and os.getresgid() == (1000, 1000, 1000)
            and os.getgroups() == [] and re.search(r'^NoNewPrivs:\s+1$', status, re.M), 'credentials')


def namespace_owner(package, owned, parent_ns, parent_fd):
    """Keep PID1 alive for all setup helpers, with failures reported before exit."""
    DIAGNOSTIC['role'] = 'namespace-owner'
    try:
        stage('bind_parent_death')
        bind_parent_death(parent_fd)
        require(os.getpid() == 1, 'pid_namespace')
        stage('make_mounts_private')
        tool('/usr/bin/mount', '--make-rprivate', '/')
        root_setup(package, owned, parent_ns, parent_fd)
        raise RuntimeError('root_lab_unexpected_setup_return')
    except BaseException as error:
        report_failure(error)
        os._exit(90)


def wait_namespace_owner(child, timeout):
    """Wait for only the owned namespace leader, leaving timeout cleanup to caller."""
    stage('wait_namespace_owner')
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        pid, status = os.waitpid(child, os.WNOHANG)
        if pid:
            return os.waitstatus_to_exitcode(status)
        time.sleep(0.1)
    raise RuntimeError('root_lab_timeout')


def execute(package, owned):
    """Create a namespace leader before spawning any short-lived setup command."""
    stage('administrative_identity')
    require(os.getuid() == 0 and os.geteuid() == 0, 'administrative_identity_required')
    parent_ns = {name: os.readlink('/proc/self/ns/' + name) for name in CAPTURE}
    libc = ctypes.CDLL(None, use_errno=True)
    stage('unshare')
    if libc.unshare(0x00020000 | 0x40000000 | 0x20000000) != 0:
        raise OSError(ctypes.get_errno(), 'unshare failed')
    # The FIRST child after CLONE_NEWPID must be the long-lived namespace owner.
    # Starting a helper command here would consume PID1 and destroy the namespace on exit.
    stage('pin_parent')
    parent_fd = os.pidfd_open(os.getpid())
    child, pidfd, reaped = None, None, False
    try:
        stage('fork_namespace_owner')
        child = os.fork()
        if child == 0:
            namespace_owner(package, owned, parent_ns, parent_fd)
        stage('pin_namespace_owner')
        pidfd = os.pidfd_open(child)
        code = wait_namespace_owner(child, package['timeoutSeconds'])
        reaped = True
        if code != 0:
            raise subprocess.CalledProcessError(code, 'namespace-owner')
    finally:
        if child and not reaped:
            # This is our own unreaped child: its PID cannot have been reused.
            try:
                if pidfd is not None:
                    signal.pidfd_send_signal(pidfd, signal.SIGKILL)
                else:
                    os.kill(child, signal.SIGKILL)
            except ProcessLookupError:
                pass  # Already exited; still reap our owned child below.
            os.waitpid(child, 0)
        if pidfd is not None:
            os.close(pidfd)
        os.close(parent_fd)


def main():
    """Inspect one pinned package and optionally execute its isolated probe."""
    require(len(sys.argv) == 4 and sys.argv[1] in ('--inspect', '--execute'), 'arguments')
    stage('inspect_package')
    package, owned = inspect(sys.argv[2], sys.argv[3])
    try:
        if sys.argv[1] == '--execute':
            execute(package, owned)
        print(json.dumps({'state': 'inspected' if sys.argv[1] == '--inspect' else 'completed'}))
    finally:
        for fd in owned:
            os.close(fd)


if __name__ == '__main__':
    try:
        main()
    except BaseException as error:
        report_failure(error)
        sys.exit(1)
