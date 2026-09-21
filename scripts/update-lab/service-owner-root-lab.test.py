"""Unprivileged refusal, diagnostics and owned-child tests; no unshare or PM2."""
import contextlib
import ctypes
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import shutil
import signal
import subprocess
import tempfile
import time
import unittest
from unittest import mock

SPEC = importlib.util.spec_from_file_location('rootlab', Path(__file__).with_name('service-owner-root-lab.py'))
LAB = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(LAB)


class RootLabTests(unittest.TestCase):
    def setUp(self):
        self.run = Path(tempfile.mkdtemp(prefix='run-', dir=LAB.BASE))
        self.run.chmod(0o700)
        for name in ('harness', 'home', 'tmp', 'var-tmp'):
            (self.run / name).mkdir(mode=0o700)
        self.files = {}
        for name in ('service-owner-probe.mjs', 'capsule.mjs', 'idle.mjs'):
            data = ('// fixture ' + name).encode()
            (self.run / 'harness' / name).write_bytes(data)
            (self.run / 'harness' / name).chmod(0o600)
            self.files[name] = hashlib.sha256(data).hexdigest()
        self.package = dict(schema='nassaj-service-owner-root-lab/v1', run=str(self.run), uid=1000,
                            gid=1000, files=self.files, timeoutSeconds=90)
        self.write_package()

    def tearDown(self):
        shutil.rmtree(self.run)

    def write_package(self):
        data = json.dumps(self.package).encode()
        (self.run / 'root-lab-package.json').write_bytes(data)
        (self.run / 'root-lab-package.json').chmod(0o600)
        self.digest = hashlib.sha256(data).hexdigest()

    def inspect(self):
        package, descriptors = LAB.inspect(str(self.run), self.digest)
        for descriptor in descriptors:
            os.close(descriptor)
        return package

    def test_valid_readonly_inspection_and_nonroot_execution_refusal(self):
        self.assertEqual(self.inspect()['uid'], 1000)
        package, descriptors = LAB.inspect(str(self.run), self.digest)
        try:
            with self.assertRaisesRegex(RuntimeError, 'administrative_identity_required'):
                LAB.execute(package, descriptors)
            self.assertFalse((self.run / 'rootfs').exists())
            self.assertEqual(self.run.stat().st_uid, 1000)
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def test_scope_uid_and_free_fields_refused(self):
        for change in ({'uid': 0}, {'command': 'anything'}, {'timeoutSeconds': 91}):
            original = self.package.copy()
            self.package.update(change)
            self.write_package()
            with self.assertRaises(RuntimeError):
                self.inspect()
            self.package = original
        with self.assertRaises(RuntimeError):
            LAB.inspect(LAB.PROJECT, self.digest)

    def test_changed_bytes_hardlinks_and_symlinks_refused(self):
        target = self.run / 'harness' / 'idle.mjs'
        saved = target.read_bytes()
        target.write_bytes(b'changed')
        with self.assertRaisesRegex(RuntimeError, 'input_digest'):
            self.inspect()
        target.write_bytes(saved)
        os.link(target, self.run / 'alias')
        with self.assertRaisesRegex(RuntimeError, 'input_metadata'):
            self.inspect()
        (self.run / 'alias').unlink()
        target.unlink()
        target.symlink_to('/usr/bin/node')
        with self.assertRaises(OSError):
            self.inspect()

    def test_component_symlink_and_held_descriptor_survive_rebinding(self):
        home = self.run / 'home'
        home.rename(self.run / 'original-home')
        home.symlink_to(self.run / 'original-home')
        with self.assertRaises(OSError):
            self.inspect()
        home.unlink()
        (self.run / 'original-home').rename(home)
        package, descriptors = LAB.inspect(str(self.run), self.digest)
        try:
            identity = os.fstat(descriptors[2]).st_ino
            home.rename(self.run / 'original-home')
            home.mkdir(mode=0o700)
            self.assertNotEqual(home.stat().st_ino, identity)
            self.assertEqual(os.fstat(descriptors[2]).st_ino, identity)
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def test_fifo_input_refuses_without_waiting_for_writer(self):
        target = self.run / 'harness' / 'idle.mjs'
        target.unlink()
        os.mkfifo(target, 0o600)
        begin = time.monotonic()
        with self.assertRaisesRegex(RuntimeError, 'input_metadata'):
            self.inspect()
        self.assertLess(time.monotonic() - begin, 0.5)

    def test_namespace_repin_rejects_replaced_run_fixture_and_symlink_without_fd_leak(self):
        package, descriptors = LAB.inspect(str(self.run), self.digest)
        replacement = self.run.with_name(self.run.name + '_retained')
        try:
            count = len(os.listdir('/proc/self/fd'))
            self.run.rename(replacement)
            self.run.mkdir(mode=0o700)
            for name in ('harness', 'home', 'tmp', 'var-tmp'):
                (self.run / name).mkdir(mode=0o700)
            with self.assertRaisesRegex(RuntimeError, 'namespace_directory_rebound'):
                LAB.namespace_directories(package, descriptors)
            self.assertEqual(len(os.listdir('/proc/self/fd')), count)
            shutil.rmtree(self.run)
            replacement.rename(self.run)
            home = self.run / 'home'
            home.rename(self.run / 'original-home')
            home.mkdir(mode=0o700)
            with self.assertRaisesRegex(RuntimeError, 'namespace_directory_rebound'):
                LAB.namespace_directories(package, descriptors)
            self.assertEqual(len(os.listdir('/proc/self/fd')), count)
            home.rmdir()
            home.symlink_to(self.run / 'original-home')
            with self.assertRaises(OSError):
                LAB.namespace_directories(package, descriptors)
            self.assertEqual(len(os.listdir('/proc/self/fd')), count)
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def test_namespace_repin_revalidates_permissions_even_when_inode_is_unchanged(self):
        package, descriptors = LAB.inspect(str(self.run), self.digest)
        try:
            count = len(os.listdir('/proc/self/fd'))
            (self.run / 'home').chmod(0o770)
            with self.assertRaisesRegex(RuntimeError, 'namespace_directory_metadata'):
                LAB.namespace_directories(package, descriptors)
            self.assertEqual(len(os.listdir('/proc/self/fd')), count)
        finally:
            for descriptor in descriptors:
                os.close(descriptor)

    def test_nonempty_home_hardlink_and_previous_effects_refused(self):
        source = self.run / 'harness' / 'idle.mjs'
        os.link(source, self.run / 'home' / 'host-hardlink')
        with self.assertRaisesRegex(RuntimeError, 'fixture_not_empty'):
            self.inspect()
        (self.run / 'home' / 'host-hardlink').unlink()
        (self.run / 'app').mkdir()
        with self.assertRaisesRegex(RuntimeError, 'previous_effects'):
            self.inspect()

    def test_parent_death_kills_only_owned_child(self):
        libc = ctypes.CDLL(None)
        self.assertEqual(libc.prctl(36, 1, 0, 0, 0), 0)  # This test becomes its grandchildren's reaper.
        read_fd, write_fd = os.pipe()
        parent = os.fork()
        if parent == 0:
            os.close(read_fd)
            parent_fd = os.pidfd_open(os.getpid())
            child = os.fork()
            if child == 0:
                LAB.bind_parent_death(parent_fd)
                os.write(write_fd, str(os.getpid()).encode())
                while True:
                    signal.pause()
            os.close(write_fd)
            while True:
                signal.pause()
        os.close(write_fd)
        child = int(os.read(read_fd, 40))
        os.close(read_fd)
        os.kill(parent, signal.SIGKILL)
        os.waitpid(parent, 0)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline:
            found, status = os.waitpid(child, os.WNOHANG)
            if found:
                self.assertEqual(os.waitstatus_to_exitcode(status), -signal.SIGKILL)
                return
            time.sleep(0.02)
        os.kill(child, signal.SIGKILL)
        os.waitpid(child, 0)
        self.fail('owned child survived parent death')


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        LAB.DIAGNOSTIC.update(role='operator', stage='arguments', operation=None)

    def report(self, error):
        output = io.StringIO()
        with contextlib.redirect_stderr(output):
            LAB.report_failure(error)
        self.assertNotIn('SECRET', output.getvalue())
        self.assertLess(len(output.getvalue()), 512)
        return json.loads(output.getvalue())

    def test_exception_text_command_output_and_unknown_names_are_redacted(self):
        errors = [OSError(12, 'SECRET'), RuntimeError('SECRET'),
                  RuntimeError('root_lab_' + 'x' * 81),
                  subprocess.CalledProcessError(32, ['SECRET'], output='SECRET', stderr='SECRET'),
                  subprocess.TimeoutExpired(['SECRET'], 10, output='SECRET', stderr='SECRET'),
                  type('SECRET_EXCEPTION', (Exception,), {})('SECRET')]
        for error in errors:
            with self.subTest(kind=type(error).__name__):
                result = self.report(error)
                self.assertNotIn('code', result)
        self.assertEqual(self.report(errors[0])['errno'], 12)
        self.assertEqual(self.report(errors[3])['exitCode'], 32)
        self.assertEqual(self.report(errors[-1])['exceptionType'], 'OtherError')
        self.assertEqual(self.report(RuntimeError('root_lab_timeout'))['code'], 'root_lab_timeout')

    def test_tool_records_only_operation_and_stage_resets_it(self):
        LAB.stage('make_mounts_private')
        with mock.patch.object(LAB.subprocess, 'run', side_effect=
                               subprocess.CalledProcessError(32, ['SECRET'])) as run:
            with self.assertRaises(subprocess.CalledProcessError) as failure:
                LAB.tool('/usr/bin/mount', 'SECRET', fds=(42,))
        result = self.report(failure.exception)
        self.assertEqual((result['stage'], result['operation']), ('make_mounts_private', 'mount'))
        self.assertEqual(run.call_args.kwargs['timeout'], 10)
        self.assertEqual(run.call_args.kwargs['pass_fds'], (42,))
        LAB.stage('rootfs_prepare')
        self.assertIsNone(LAB.DIAGNOSTIC['operation'])

    def test_bind_closes_detached_tree_on_setattr_and_move_failure(self):
        for failing in ('mount_setattr', 'move_mount'):
            with self.subTest(operation=failing):
                tree = os.open('/dev/null', os.O_RDONLY)
                libc = mock.Mock()
                libc.open_tree.return_value = tree
                libc.mount_setattr.return_value = -1 if failing == 'mount_setattr' else 0
                libc.move_mount.return_value = -1 if failing == 'move_mount' else 0
                ctypes.set_errno(1)
                with mock.patch.object(LAB.ctypes, 'CDLL', return_value=libc):
                    with self.assertRaises(OSError) as error:
                        LAB.bind(80, 81, readonly=True, recursive=True)
                self.assertEqual(error.exception.errno, 1)
                self.assertEqual(LAB.DIAGNOSTIC['operation'], failing)
                with self.assertRaises(OSError):
                    os.fstat(tree)
                if failing == 'mount_setattr':
                    libc.move_mount.assert_not_called()

    def test_open_tree_failure_never_attaches_or_closes_unknown_descriptor(self):
        libc = mock.Mock()
        libc.open_tree.return_value = -1
        ctypes.set_errno(9)
        with mock.patch.object(LAB.ctypes, 'CDLL', return_value=libc), mock.patch.object(LAB.os, 'close') as close:
            with self.assertRaises(OSError) as error:
                LAB.bind(80, 81)
        self.assertEqual(error.exception.errno, 9)
        libc.move_mount.assert_not_called()
        close.assert_not_called()


if __name__ == '__main__':
    unittest.main()
