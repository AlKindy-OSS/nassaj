#!/usr/bin/python3
"""Read-only verification for the one retained current-source probe packet."""
import hashlib
import json
import os
import shlex
import stat
import subprocess
import sys
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
REPAIR = ROOT / '.artifacts/t1772-current-readiness-20260919/repair-20260920'
REVIEW = REPAIR / 'service-owner-probe-current-source-review.json'
COMMAND = REPAIR / 'service-owner-probe-current-source-command.sh'
HELPER = ROOT / 'scripts/update-lab/service-owner-root-lab.py'
RUN = ROOT / '.artifacts/t1772-bridge-rehearsal/run-YjL6Yu'
PACKAGE = RUN / 'root-lab-package.json'
PROBE = ROOT / 'scripts/update-lab/service-owner-probe.mjs'
SOURCE_COMMIT = 'b9e92bf6a75fb9934e216dbd9293d2a7607c5c77'

PROBE_SHA256 = '1902e79cc1cac9d88323a9d25904b106127b4dd1dfd29fb5714cbc20ce0c8eef'
CAPSULE_SHA256 = '558b3885e23fe1bb56a564912c43545b9d1e2472019dbc398c7abdf0e6e96126'
IDLE_SHA256 = '174c3e0045409140507b191ab7bcf7b915b3f386d486a190b349c8e8d4ec53a2'
HELPER_SHA256 = 'dd7f7aca4cb77bd85124488b0e17f84621e75fd4419cb2c77acbc0933b000318'
PACKAGE_SHA256 = '57d6f0bb8d3d1d46631e59b7a516c6d3afe511ef92ea81f83856983a9094420d'
COMMAND_SHA256 = 'c20b07de46d07c15f31b9b8d9f51fe251627866a7e21375d14696bf8d3160411'
REVIEW_SHA256 = '9e69a1232524712539a1021d2e3fa411eff1f3293c2f495077c285f7edbd20f1'

PINNED_FILES = {
    REVIEW: (REVIEW_SHA256, 0o664),
    COMMAND: (COMMAND_SHA256, 0o664),
    HELPER: (HELPER_SHA256, 0o644),
    PACKAGE: (PACKAGE_SHA256, 0o600),
    PROBE: (PROBE_SHA256, 0o664),
    RUN / 'harness/service-owner-probe.mjs': (PROBE_SHA256, 0o600),
    RUN / 'harness/capsule.mjs': (CAPSULE_SHA256, 0o600),
    RUN / 'harness/idle.mjs': (IDLE_SHA256, 0o600),
}

BOOTSTRAP_PROGRAM = (
    'import os,sys,stat,hashlib; assert len(sys.argv)==5; p,h,r,q=sys.argv[1:]; '
    'f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC); s=os.fstat(f); '
    'assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==1000 and not s.st_mode&0o022 '
    'and 0<s.st_size<=100000; b=os.read(f,100001); os.close(f); assert len(b)==s.st_size '
    'and hashlib.sha256(b).hexdigest()==h; sys.argv=[p,\'--execute\',r,q]; '
    'exec(compile(b,p,\'exec\'),{\'__name__\':\'__main__\',\'__file__\':p})'
)
EXPECTED_COMMAND = (
    'sudo', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/usr/sbin', 'LANG=C',
    '/usr/bin/python3.13', '-I', '-S', '-B', '-c', BOOTSTRAP_PROGRAM,
    str(HELPER), HELPER_SHA256, str(RUN), PACKAGE_SHA256,
)


class IntegrityError(ValueError):
    """Raised when one immutable packet invariant does not hold."""


def require(value, code):
    """Reject an invariant using a bounded diagnostic code."""
    if not value:
        raise IntegrityError(code)


def _identity(metadata):
    """Return the fields that must stay stable while a constrained file is read."""
    return (metadata.st_dev, metadata.st_ino, metadata.st_mode, metadata.st_uid,
            metadata.st_gid, metadata.st_nlink, metadata.st_size,
            metadata.st_mtime_ns, metadata.st_ctime_ns)


def read_pinned(path, expected_digest=None, expected_mode=None):
    """Read one fixed regular file through a non-following descriptor and pin its identity."""
    try:
        pinned_digest, pinned_mode = PINNED_FILES[path]
    except KeyError as error:
        raise IntegrityError('unapproved_path') from error
    require(expected_digest in (None, pinned_digest), 'digest_pin')
    require(expected_mode in (None, pinned_mode), 'mode_pin')
    before = os.lstat(path)
    require(stat.S_ISREG(before.st_mode), 'not_regular')
    require(before.st_uid == 1000 and before.st_gid == 1000, 'unexpected_owner')
    require(stat.S_IMODE(before.st_mode) == pinned_mode and before.st_nlink == 1,
            'unsafe_permissions')
    descriptor = os.open(path, os.O_RDONLY | os.O_NOFOLLOW | os.O_CLOEXEC)
    try:
        opened = os.fstat(descriptor)
        require(_identity(before) == _identity(opened), 'file_changed')
        content = bytearray()
        while True:
            chunk = os.read(descriptor, 65536)
            if not chunk:
                break
            content.extend(chunk)
            require(len(content) <= 1_000_000, 'file_too_large')
        closed = os.fstat(descriptor)
    finally:
        os.close(descriptor)
    after = os.lstat(path)
    require(_identity(before) == _identity(closed) == _identity(after), 'file_changed')
    value = bytes(content)
    require(hashlib.sha256(value).hexdigest() == pinned_digest, 'digest_mismatch')
    return value


def load_json(path):
    """Decode a pinned JSON evidence file after descriptor-level validation."""
    try:
        return json.loads(read_pinned(path).decode('utf-8'))
    except (UnicodeDecodeError, json.JSONDecodeError) as error:
        raise IntegrityError('invalid_json') from error


def verify_review_evidence():
    """Check the retained review only as corroboration; it supplies no trust anchors."""
    review = load_json(REVIEW)
    expected = {
        'schema': 'nassaj-root-lab-review/v1',
        'state': 'current-source-packet-prepared_pending_qa_not_executed',
        'run': str(RUN), 'helper': str(HELPER), 'helperSha256': HELPER_SHA256,
        'packagePath': str(PACKAGE), 'packageSha256': PACKAGE_SHA256,
        'commandPath': str(COMMAND), 'commandSha256': COMMAND_SHA256,
        'files': {'service-owner-probe.mjs': PROBE_SHA256, 'capsule.mjs': CAPSULE_SHA256,
                  'idle.mjs': IDLE_SHA256},
        'sourceCommit': SOURCE_COMMIT,
        'scope': 'One isolated PM2 probe; no live restart, service maintenance, deployment or administrative execution.',
        'repair': 'Replaced only the pinned probe source with the explicit watch:false revision; retained prior capsule and idle bytes.',
        'rollback': 'Do not execute the new command; the isolated run directory can remain retained as review evidence.',
        'administrativeExecution': False,
    }
    require(review == expected, 'review_mismatch')


def verify_package():
    """Bind the fixed package manifest to the fixed harness content."""
    package = load_json(PACKAGE)
    expected = {
        'schema': 'nassaj-service-owner-root-lab/v1', 'run': str(RUN), 'uid': 1000,
        'gid': 1000, 'files': {'service-owner-probe.mjs': PROBE_SHA256,
        'capsule.mjs': CAPSULE_SHA256, 'idle.mjs': IDLE_SHA256}, 'timeoutSeconds': 90,
    }
    require(package == expected, 'package_mismatch')
    for path in (RUN / 'harness/service-owner-probe.mjs', RUN / 'harness/capsule.mjs',
                 RUN / 'harness/idle.mjs', PROBE, HELPER, COMMAND):
        read_pinned(path)


def verify_source_commit():
    """Confirm the pinned working probe exactly matches its declared immutable commit."""
    result = subprocess.run(
        ['/usr/bin/git', 'show', f'{SOURCE_COMMIT}:scripts/update-lab/service-owner-probe.mjs'],
        cwd=ROOT, env={'PATH': '/usr/bin:/bin', 'LANG': 'C', 'LC_ALL': 'C',
                       'GIT_CONFIG_NOSYSTEM': '1', 'HOME': '/nonexistent'},
        capture_output=True, check=False, timeout=5)
    require(result.returncode == 0, 'source_commit_unavailable')
    require(hashlib.sha256(result.stdout).hexdigest() == PROBE_SHA256, 'source_commit_mismatch')


def verify_command():
    """Require the complete fixed command, including clean environment and interpreter."""
    try:
        actual = tuple(shlex.split(read_pinned(COMMAND).decode('utf-8'), posix=True))
    except ValueError as error:
        raise IntegrityError('command_parse') from error
    require(actual == EXPECTED_COMMAND, 'command_shape')


def verify():
    """Prove the fixed command, helper, package and source bytes form one packet."""
    verify_review_evidence()
    verify_package()
    verify_source_commit()
    verify_command()
    return {
        'schema': 'nassaj-current-source-integrity/v1', 'state': 'verified',
        'administrativeExecution': False, 'sourceCommit': SOURCE_COMMIT,
        'commandSha256': COMMAND_SHA256, 'helperSha256': HELPER_SHA256,
        'packageSha256': PACKAGE_SHA256, 'probeSha256': PROBE_SHA256,
    }


def main():
    """Run the read-only packet check and emit machine-readable success or refusal."""
    if len(sys.argv) != 1:
        print('usage: service-owner-current-source-integrity.py', file=sys.stderr)
        return 2
    try:
        print(json.dumps(verify(), sort_keys=True))
    except (IntegrityError, OSError, subprocess.SubprocessError) as error:
        print(json.dumps({'schema': 'nassaj-current-source-integrity/v1', 'state': 'refused',
                          'code': str(error) if isinstance(error, IntegrityError) else 'invalid_input'},
                         sort_keys=True), file=sys.stderr)
        return 1
    return 0


if __name__ == '__main__':
    raise SystemExit(main())
