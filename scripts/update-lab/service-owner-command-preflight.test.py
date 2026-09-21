"""Validate the delivered outer bootstrap, including metadata, before administrative execution."""
import hashlib
import json
import os
from pathlib import Path
import shlex
import subprocess
import tempfile
import unittest

ROOT = Path(__file__).resolve().parents[2]
REVIEW = ROOT / '.artifacts/t1772-current-readiness-20260919/repair-20260920'
COMMAND = REVIEW / 'service-owner-probe-command.sh'
# Reviewed administrative trust boundary. Tests execute it WITHOUT sudo and ONLY with --inspect.
BOOTSTRAP = "import os,sys,stat,hashlib; assert len(sys.argv)==5; p,h,r,q=sys.argv[1:]; f=os.open(p,os.O_RDONLY|os.O_NOFOLLOW|os.O_NONBLOCK|os.O_CLOEXEC); s=os.fstat(f); assert stat.S_ISREG(s.st_mode) and s.st_nlink==1 and s.st_uid==1000 and not s.st_mode&0o022 and 0<s.st_size<=100000; b=os.read(f,100001); os.close(f); assert len(b)==s.st_size and hashlib.sha256(b).hexdigest()==h; sys.argv=[p,'--execute',r,q]; exec(compile(b,p,'exec'),{'__name__':'__main__','__file__':p})"


def inspect_prefix(arguments):
    """Use exactly the command's verifier and in-memory compile, changing only the operation."""
    program = BOOTSTRAP.replace("[p,'--execute',r,q]", "[p,'--inspect',r,q]")
    return subprocess.run(['/usr/bin/env', '-i', 'PATH=/usr/bin:/usr/sbin', 'LANG=C',
                           '/usr/bin/python3.13', '-I', '-S', '-B', '-c', program, *arguments],
                          capture_output=True, text=True, timeout=5)


class CommandPreflightTests(unittest.TestCase):
    def test_group_writable_source_refuses_before_compile_and_chmod_preserves_digest(self):
        with tempfile.TemporaryDirectory(prefix='command-preflight-', dir=ROOT / '.artifacts') as directory:
            helper = Path(directory) / 'helper.py'
            marker = Path(directory) / 'compiled'
            data = ("import sys\nassert sys.argv[1]=='--inspect'\n"
                    f"open({str(marker)!r},'w').write('inspected')\n").encode()
            helper.write_bytes(data)
            digest = hashlib.sha256(data).hexdigest()
            helper.chmod(0o664)
            result = inspect_prefix([str(helper), digest, directory, 'a' * 64])
            self.assertNotEqual(result.returncode, 0)
            self.assertFalse(marker.exists())
            helper.chmod(0o644)
            self.assertEqual(hashlib.sha256(helper.read_bytes()).hexdigest(), digest)
            result = inspect_prefix([str(helper), digest, directory, 'a' * 64])
            self.assertEqual(result.returncode, 0, result.stderr)
            self.assertEqual(marker.read_text(), 'inspected')

    def test_outer_bootstrap_fifo_refuses_without_blocking(self):
        with tempfile.TemporaryDirectory(prefix='command-preflight-', dir=ROOT / '.artifacts') as directory:
            helper = Path(directory) / 'helper.py'
            os.mkfifo(helper, 0o600)
            result = inspect_prefix([str(helper), 'a' * 64, directory, 'a' * 64])
            self.assertNotEqual(result.returncode, 0)

    @unittest.skipUnless(COMMAND.exists(), 'installation-specific review artifact not present')
    def test_actual_delivered_command_and_package_reach_inspection_without_root(self):
        review = json.loads((REVIEW / 'service-owner-probe-review.json').read_text())
        command_bytes = COMMAND.read_bytes()
        self.assertEqual(hashlib.sha256(command_bytes).hexdigest(), review['commandSha256'])
        args = shlex.split(command_bytes.decode())
        self.assertEqual(args[:11], ['sudo', '--', '/usr/bin/env', '-i', 'PATH=/usr/bin:/usr/sbin',
                                   'LANG=C', '/usr/bin/python3.13', '-I', '-S', '-B', '-c'])
        self.assertEqual(args[11], BOOTSTRAP)
        self.assertEqual(args[12:], [review['helper'], review['helperSha256'], review['run'], review['packageSha256']])
        run = Path(review['run'])
        before = sorted(p.name for p in run.iterdir())
        result = inspect_prefix(args[12:])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(json.loads(result.stdout), {'state': 'inspected'})
        self.assertEqual(sorted(p.name for p in run.iterdir()), before)
        self.assertFalse((run / 'rootfs').exists())
        self.assertFalse((run / 'service-owner-probe.json').exists())


if __name__ == '__main__':
    unittest.main()
