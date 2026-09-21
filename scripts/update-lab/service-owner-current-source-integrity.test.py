"""Exercise the read-only integrity check for the retained current-source probe packet."""
import hashlib
import importlib.util
import json
from pathlib import Path
import shlex
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
CHECK = ROOT / 'scripts/update-lab/service-owner-current-source-integrity.py'
SPEC = importlib.util.spec_from_file_location('current_source_integrity', CHECK)
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class CurrentSourceIntegrityTests(unittest.TestCase):
    """Confirm fixed anchors accept only the intended non-administrative packet."""

    def run_check(self, *arguments):
        """Run the read-only verifier, never its administrative command."""
        return subprocess.run([sys.executable, str(CHECK), *arguments], text=True,
                              capture_output=True, timeout=10, check=False)

    def test_current_packet_verifies_without_administrative_execution(self):
        """The delivered source and retained harness carry one probe digest."""
        result = self.run_check()
        self.assertEqual(result.returncode, 0, result.stderr)
        report = json.loads(result.stdout)
        self.assertEqual(report['state'], 'verified')
        self.assertFalse(report['administrativeExecution'])
        self.assertEqual(report['sourceCommit'], MODULE.SOURCE_COMMIT)
        self.assertEqual(report['probeSha256'], MODULE.PROBE_SHA256)

    def test_review_and_file_switch_cannot_supply_new_trust(self):
        """The removed review option refuses an attacker-selected review and command."""
        result = self.run_check('--review', '/unapproved/review.json',
                                '/unapproved/command.sh')
        self.assertEqual(result.returncode, 2)
        self.assertIn('usage:', result.stderr)

    def test_symlink_is_rejected_before_content_is_trusted(self):
        """Descriptor opening and lstat refuse a link even when bytes match a pin."""
        with tempfile.TemporaryDirectory(prefix='current-source-integrity-', dir=ROOT / 'scripts/update-lab') as directory:
            target = Path(directory) / 'target'
            link = Path(directory) / 'link'
            target.write_text('pinned bytes', encoding='utf-8')
            link.symlink_to(target)
            original = MODULE.PINNED_FILES
            try:
                MODULE.PINNED_FILES = {link: (hashlib.sha256(b'pinned bytes').hexdigest(), 0o600)}
                with self.assertRaisesRegex(MODULE.IntegrityError, 'not_regular'):
                    MODULE.read_pinned(link)
            finally:
                MODULE.PINNED_FILES = original

    def test_middle_command_argument_is_rejected(self):
        """A permitted prefix and suffix cannot hide an inserted environment assignment."""
        tampered = list(MODULE.EXPECTED_COMMAND)
        tampered.insert(6, 'PYTHONPATH=/tmp/attacker')
        command_bytes = shlex.join(tampered).encode('utf-8')
        with patch.object(MODULE, 'read_pinned', return_value=command_bytes) as reader:
            with self.assertRaisesRegex(MODULE.IntegrityError, 'command_shape'):
                MODULE.verify_command()
        reader.assert_called_once_with(MODULE.COMMAND)

    def test_consistent_review_and_helper_tampering_is_rejected(self):
        """Even matching replacement bytes and review hashes cannot replace fixed trust."""
        review = json.loads(MODULE.read_pinned(MODULE.REVIEW))
        helper_bytes = MODULE.read_pinned(MODULE.HELPER) + b'\n# replaced helper\n'
        review['helperSha256'] = hashlib.sha256(helper_bytes).hexdigest()
        replaced_files = {
            MODULE.REVIEW: json.dumps(review).encode('utf-8'),
            MODULE.HELPER: helper_bytes,
        }
        # Bypass file-level pins to exercise the independent fixed review contract.
        with patch.object(MODULE, 'read_pinned', side_effect=replaced_files.__getitem__):
            supplied_review = MODULE.load_json(MODULE.REVIEW)
            self.assertEqual(supplied_review['helperSha256'], hashlib.sha256(
                MODULE.read_pinned(Path(supplied_review['helper']))).hexdigest())
            self.assertNotEqual(supplied_review['helperSha256'], MODULE.HELPER_SHA256)
            with self.assertRaisesRegex(MODULE.IntegrityError, 'review_mismatch'):
                MODULE.verify_review_evidence()

    def test_unapproved_path_is_rejected(self):
        """No caller-controlled path can be opened through the pinned reader."""
        with self.assertRaisesRegex(MODULE.IntegrityError, 'unapproved_path'):
            MODULE.read_pinned(Path('/var/tmp/not-an-approved-packet-file'))


if __name__ == '__main__':
    unittest.main()
