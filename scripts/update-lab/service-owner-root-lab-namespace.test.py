"""Real kernel regression tests in unprivileged user namespaces; no PM2 or sudo."""
import json
import os
from pathlib import Path
import subprocess
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[2]
HELPER = ROOT / 'scripts/update-lab/service-owner-root-lab.py'
PRELUDE = """
import ctypes, errno, importlib.util, json, os, subprocess, sys
from pathlib import Path
spec = importlib.util.spec_from_file_location('rootlab', sys.argv[1])
lab = importlib.util.module_from_spec(spec)
spec.loader.exec_module(lab)
"""

# Only inspected fixture metadata is mapped to UID/GID1000 for a map-root-user test.
# Host root files remain overflow-owned here. This does NOT qualify trusted root runtime.
FULL_SETUP = r'''
import hashlib
root = Path(sys.argv[2])
probe = r"""
import fs from 'node:fs';
import assert from 'node:assert/strict';
assert.equal(process.pid, 1);
assert.equal(process.getuid(), 0); // Rootless mapping only; never the production probe.
assert.equal(fs.existsSync('/put_old'), false);
assert.equal(fs.existsSync('/home/operator/Project/nassaj-dev/.git'), false);
const status = fs.readFileSync('/proc/self/status', 'utf8');
for (const key of ['CapInh','CapPrm','CapEff','CapBnd','CapAmb'])
    assert.match(status, new RegExp(`^${key}:\\s+0+$`, 'm'));
assert.match(status, /^NoNewPrivs:\s+1$/m);
assert.throws(() => fs.writeFileSync('/usr/rootlab-must-refuse', 'x'), {code:'EROFS'});
fs.writeFileSync('/dev/null', 'safe fixture');
console.log(JSON.stringify({pivot:true, oldRootDetached:true, nodeExec:true,
    capabilitiesZero:true, noNewPrivileges:true, rootlessFixtureUid:process.getuid()}));
"""
files = {}
for name in ('harness', 'home', 'tmp', 'var-tmp'):
    (root / name).mkdir(mode=0o700)
for name in ('service-owner-probe.mjs', 'capsule.mjs', 'idle.mjs'):
    data = (probe if name == 'service-owner-probe.mjs' else '// inert fixture').encode()
    (root / 'harness' / name).write_bytes(data)
    (root / 'harness' / name).chmod(0o600)
    files[name] = hashlib.sha256(data).hexdigest()
# Crucial: retain these FDs BEFORE execute creates its mount namespace.
owned = [lab.open_directory(str(root))]
owned += [lab.open_directory(str(root / name)) for name in ('harness','home','tmp','var-tmp')]
inputs = [root, *root.iterdir(), *(root / 'harness').iterdir()]
identities = {(path.stat().st_dev, path.stat().st_ino) for path in inputs}
real_fstat = os.fstat
class FixtureMetadata:
    def __init__(self, actual):
        self.actual = actual
        self.st_uid = self.st_gid = 1000
    def __getattr__(self, name):
        return getattr(self.actual, name)
def mapped_fstat(fd):
    actual = real_fstat(fd)
    return FixtureMetadata(actual) if (actual.st_dev, actual.st_ino) in identities else actual
lab.os.fstat = mapped_fstat
real_drop = lab.drop_authority
def rootless_drop(parent_fd):
    assert not os.path.exists('/put_old')
    assert os.getcwd() == '/lab'
    for value in os.listdir('/proc/self/fd'):
        fd = int(value)
        try:
            real_fstat(fd)
        except OSError as error:
            assert error.errno == errno.EBADF
            continue
        assert fd <= 2 or fd == parent_fd, 'old root descriptor leaked'
    print(json.dumps({'reachedDrop':True, 'oldDescriptorsClosed':True}), flush=True)
    if sys.argv[3] == 'real-drop-refusal':
        real_drop(parent_fd)  # EPERM: single-ID userns cannot setgroups/setresuid(1000).
        raise AssertionError('single-ID namespace unexpectedly supports production drop')
    # Real capability removal and NNP; UID remains mapped0 solely for this inert fixture.
    libc = ctypes.CDLL(None, use_errno=True)
    last = int(Path('/proc/sys/kernel/cap_last_cap').read_text())
    assert libc.prctl(47, 4, 0, 0, 0) == 0
    for capability in range(last + 1):
        assert libc.prctl(24, capability, 0, 0, 0) == 0
    assert libc.prctl(38, 1, 0, 0, 0) == 0
    header = (ctypes.c_uint32 * 2)(0x20080522, 0)
    data = (ctypes.c_uint32 * 6)()
    assert libc.capset(ctypes.byref(header), ctypes.byref(data)) == 0
    lab.bind_parent_death(parent_fd)
lab.drop_authority = rootless_drop
try:
    lab.execute({'run':str(root), 'files':files, 'timeoutSeconds':10}, owned)
except BaseException as error:
    lab.report_failure(error)
    sys.exit(1)
'''


class NamespaceTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        probe = subprocess.run(['/usr/bin/unshare', '--user', '--map-root-user',
                                '--mount', '--net', '--pid', '--fork', '/usr/bin/true'],
                               capture_output=True, text=True, timeout=5)
        if probe.returncode:
            raise unittest.SkipTest('unprivileged user/mount/network/PID namespaces unavailable')

    def run_isolated(self, code, *arguments):
        """Run the actual helper in an outer user namespace, never host root."""
        return subprocess.run(['/usr/bin/unshare', '--user', '--map-root-user',
                               '/usr/bin/python3.13', '-I', '-S', '-B', '-c',
                               PRELUDE + code, str(HELPER), *map(str, arguments)],
                              capture_output=True, text=True, timeout=20)

    def test_old_order_reproduces_enomem_after_short_lived_pid_one(self):
        result = self.run_isolated("""
libc = ctypes.CDLL(None, use_errno=True)
assert libc.unshare(0x00020000 | 0x40000000 | 0x20000000) == 0
subprocess.run(['/usr/bin/true'], check=True)
try:
    os.fork()
except OSError as error:
    assert error.errno == errno.ENOMEM
    print(json.dumps({'oldOrderErrno': error.errno}))
else:
    raise AssertionError('expected destroyed PID namespace')
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'oldOrderErrno': 12})

    def test_actual_root_setup_pivots_detaches_closes_host_fds_and_executes_inert_node(self):
        before = Path('/proc/self/mountinfo').read_text()
        with tempfile.TemporaryDirectory(prefix='rootlab-full-', dir=ROOT / '.artifacts') as run:
            result = self.run_isolated(FULL_SETUP, run, 'rootless-exec')
            self.assertEqual(result.returncode, 0, result.stderr)
            drop, executed = map(json.loads, result.stdout.splitlines())
            self.assertTrue(drop['oldDescriptorsClosed'])
            self.assertTrue(executed['nodeExec'])
            self.assertTrue(executed['capabilitiesZero'])
            self.assertEqual(executed['rootlessFixtureUid'], 0)
        self.assertEqual(Path('/proc/self/mountinfo').read_text(), before)

    def test_actual_root_setup_real_identity_drop_refuses_unmapped_identity_before_exec(self):
        with tempfile.TemporaryDirectory(prefix='rootlab-drop-', dir=ROOT / '.artifacts') as run:
            result = self.run_isolated(FULL_SETUP, run, 'real-drop-refusal')
            self.assertEqual(result.returncode, 1, result.stderr)
            self.assertTrue(json.loads(result.stdout)['oldDescriptorsClosed'])
            child, parent = map(json.loads, result.stderr.splitlines())
            self.assertEqual((child['stage'], child['exceptionType'], child['errno']),
                             ('drop_authority', 'PermissionError', 1))
            self.assertEqual(parent['exitCode'], 90)
            self.assertNotIn('nodeExec', result.stdout)

    def test_historical_pre_unshare_descriptor_reproduces_pivot_einval(self):
        with tempfile.TemporaryDirectory(prefix='rootlab-oldfd-', dir=ROOT / '.artifacts') as run:
            result = self.run_isolated("""
held = lab.open_directory(sys.argv[2])
def setup(*args):
    os.mkdir('rootfs', 0o700, dir_fd=held)
    root = os.open('rootfs', lab.DIRECTORY, dir_fd=held)
    old_mount = lab.mount_identity(root)
    name = '/proc/self/fd/' + str(root)
    lab.tool('/usr/bin/mount', '--bind', name, name, fds=(root,))
    stale = os.open('rootfs', lab.DIRECTORY, dir_fd=held)
    current = lab.open_directory(sys.argv[2] + '/rootfs')
    assert lab.mount_identity(stale) == old_mount
    assert lab.mount_identity(current) != old_mount
    os.mkdir('put_old', 0o700, dir_fd=stale)
    os.fchdir(stale)
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.pivot_root(b'.', b'put_old') == -1
    assert ctypes.get_errno() == errno.EINVAL
    print(json.dumps({'pivotErrno':22, 'staleMountId':old_mount,
                      'currentMountId':lab.mount_identity(current)}), flush=True)
    os._exit(0)
lab.root_setup = setup
lab.execute({'timeoutSeconds':10}, [])
""", run)
            self.assertEqual(result.returncode, 0, result.stderr)
            evidence = json.loads(result.stdout)
            self.assertEqual(evidence['pivotErrno'], 22)
            self.assertNotEqual(evidence['staleMountId'], evidence['currentMountId'])

    def test_descriptor_mount_survives_source_target_rebinding_and_preserves_recursive_flags(self):
        with tempfile.TemporaryDirectory(prefix='rootlab-pinned-', dir=ROOT / '.artifacts') as run:
            result = self.run_isolated("""
def setup(*args):
    root = Path(sys.argv[2])
    for name in ('source', 'target'):
        (root / name).mkdir()
    (root / 'source/data').write_text('pinned source')
    nested = root / 'source/nested'
    nested.mkdir()
    libc = ctypes.CDLL(None, use_errno=True)
    assert libc.mount(b'tmpfs', str(nested).encode(), b'tmpfs', 2|4|8, b'size=4096') == 0
    (nested / 'data').write_text('nested source')
    source = lab.open_directory(str(root / 'source'))
    target = lab.open_directory(str(root / 'target'))
    real_loader = lab.ctypes.CDLL
    class RebindingLibc:
        def __getattr__(self, name):
            return getattr(libc, name)
        def move_mount(self, *arguments):
            (root / 'source').rename(root / 'retained-source')
            (root / 'source').mkdir()
            (root / 'source/decoy').write_text('untouched')
            (root / 'target').rename(root / 'retained-target')
            (root / 'target').mkdir()
            return libc.move_mount(*arguments)
    lab.ctypes.CDLL = lambda *args, **kwargs: RebindingLibc()
    try:
        lab.bind(source, target, readonly=True, recursive=True)
    finally:
        lab.ctypes.CDLL = real_loader
    retained = root / 'retained-target'
    assert (retained / 'data').read_text() == 'pinned source'
    assert (retained / 'nested/data').read_text() == 'nested source'
    for target in (retained / 'blocked', retained / 'nested/blocked'):
        try:
            target.write_text('must refuse')
        except OSError as error:
            assert error.errno == errno.EROFS
        else:
            raise AssertionError('recursive readonly missing')
    info = next(line.split() for line in Path('/proc/self/mountinfo').read_text().splitlines()
                if line.split()[4] == str(retained / 'nested'))
    assert {'ro','nosuid','nodev','noexec'} <= set(info[5].split(','))
    assert list((root / 'target').iterdir()) == []
    assert (root / 'source/decoy').read_text() == 'untouched'
    (root / 'retained-source/data').write_text('original remains writable')
    (root / 'retained-source/nested/data').write_text('original nested remains writable')
    (root / 'proc').mkdir()
    proc_fd = lab.open_directory(str(root / 'proc'))
    (root / 'proc').rename(root / 'retained-proc')
    (root / 'proc').mkdir()
    lab.mount_proc(proc_fd)
    assert (root / 'retained-proc/self').readlink() == Path('1')
    assert list((root / 'proc').iterdir()) == []
    print(json.dumps({'descriptorPinned':True, 'recursiveReadonly':True,
                      'flagsPreserved':True, 'replacementUntouched':True,
                      'procTargetPinned':True}), flush=True)
    os._exit(0)
lab.root_setup = setup
lab.execute({'timeoutSeconds':10}, [])
""", run)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(all(json.loads(result.stdout).values()))

    def test_fixed_owner_runs_real_mounts_and_keeps_parent_mounts_unchanged(self):
        before = Path('/proc/self/mountinfo').read_text()
        with tempfile.TemporaryDirectory(prefix='rootlab-kernel-', dir=ROOT / '.artifacts') as run:
            result = self.run_isolated("""
def setup(package, owned, parent_ns, parent_fd):
    assert os.getpid() == 1
    assert os.readlink('/proc/self/ns/user') == parent_ns['user']
    for name in ('mnt', 'net'):
        assert os.readlink('/proc/self/ns/' + name) != parent_ns[name]
    root = Path(sys.argv[2])
    (root / 'source').mkdir()
    (root / 'source' / 'data').write_text('pinned')
    for name in ('target', 'proc'):
        (root / name).mkdir()
    source = lab.open_directory(str(root / 'source'))
    target = lab.open_directory(str(root / 'target'))
    lab.bind(source, target, readonly=True, recursive=True)
    assert (root / 'target' / 'data').read_text() == 'pinned'
    try:
        (root / 'target' / 'blocked').write_text('must refuse')
    except OSError as error:
        assert error.errno == errno.EROFS
    else:
        raise AssertionError('recursive bind is writable')
    (root / 'file-target').touch()
    source_file = os.open(root / 'source' / 'data', os.O_RDONLY)
    target_file = os.open(root / 'file-target', os.O_RDONLY)
    lab.bind(source_file, target_file, readonly=True)
    assert (root / 'file-target').read_text() == 'pinned'
    try:
        (root / 'file-target').write_text('must refuse')
    except OSError as error:
        assert error.errno == errno.EROFS
    else:
        raise AssertionError('file bind is writable')
    proc = lab.open_directory(str(root / 'proc'))
    lab.tool('/usr/bin/mount', '-t', 'proc', '-o', 'nosuid,nodev,noexec',
             'proc', '/proc/self/fd/' + str(proc), fds=(proc,))
    assert (root / 'proc' / 'self').readlink() == Path('1')
    subprocess.run(['/usr/bin/true'], check=True)
    subprocess.run(['/usr/bin/true'], check=True)
    print(json.dumps({'pidOneAlive': True, 'recursiveReadonly': True, 'fileReadonly': True,
                      'procPid': 1, 'helperCommands': 2}), flush=True)
    os._exit(0)
lab.root_setup = setup
lab.execute({'timeoutSeconds': 10}, [])
""", run)
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertTrue(json.loads(result.stdout)['pidOneAlive'])
            self.assertEqual(list((Path(run) / 'target').iterdir()), [])
            self.assertEqual(list((Path(run) / 'proc').iterdir()), [])
        self.assertEqual(Path('/proc/self/mountinfo').read_text(), before)

    def test_failed_setup_reports_child_stage_errno_and_parent_exit(self):
        result = self.run_isolated("""
def setup(*args):
    lab.stage('bind_fixtures')
    raise PermissionError(13, 'SECRET_ARGUMENT_AND_PATH')
lab.root_setup = setup
try:
    lab.execute({'timeoutSeconds': 5}, [])
except BaseException as error:
    lab.report_failure(error)
else:
    raise AssertionError('setup unexpectedly succeeded')
try:
    os.waitpid(-1, os.WNOHANG)
except ChildProcessError:
    pass
else:
    raise AssertionError('owned child not reaped')
""")
        self.assertEqual(result.returncode, 0, result.stderr)
        child, parent = map(json.loads, result.stderr.splitlines())
        self.assertEqual((child['role'], child['stage'], child['exceptionType'], child['errno']),
                         ('namespace-owner', 'bind_fixtures', 'PermissionError', 13))
        self.assertEqual((parent['stage'], parent['exitCode']), ('wait_namespace_owner', 90))
        self.assertNotIn('SECRET', result.stderr)

    def test_timeout_and_pidfd_failure_reap_only_owned_namespace_child(self):
        for failure in ('timeout', 'pidfd'):
            with self.subTest(failure=failure):
                result = self.run_isolated("""
import time
def setup(*args):
    time.sleep(30)
lab.root_setup = setup
original = os.pidfd_open
if sys.argv[2] == 'pidfd':
    def pin(pid):
        if pid != os.getpid():
            raise OSError(errno.EMFILE, 'SECRET_PATH')
        return original(pid)
    os.pidfd_open = pin
try:
    lab.execute({'timeoutSeconds': 0.15}, [])
except BaseException as error:
    lab.report_failure(error)
else:
    raise AssertionError('failure not reported')
try:
    os.waitpid(-1, os.WNOHANG)
except ChildProcessError:
    pass
else:
    raise AssertionError('owned child not reaped')
""", failure)
                self.assertEqual(result.returncode, 0, result.stderr)
                diagnostic = json.loads(result.stderr)
                if failure == 'timeout':
                    self.assertEqual(diagnostic['code'], 'root_lab_timeout')
                else:
                    self.assertEqual((diagnostic['stage'], diagnostic['errno']),
                                     ('pin_namespace_owner', 24))
                self.assertNotIn('SECRET', result.stderr)


if __name__ == '__main__':
    unittest.main()
