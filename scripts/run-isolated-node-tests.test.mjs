// B-1420: the isolated runner must give every case its own HOME/CLAUDE_CONFIG_DIR
// and drop inherited live-root variables, so fixtures cannot write into trees the
// live server watches.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const tempParent = mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'runner-env-'));

test.after(() => rmSync(tempParent, { recursive: true, force: true }));

test('a case sees a run-root HOME and CLAUDE_CONFIG_DIR and no live-root variables', () => {
  const result = spawnSync(process.execPath, [
    'scripts/run-isolated-node-tests.mjs', 'server', 'scripts/fixtures/runner-env-probe.mjs',
  ], {
    encoding: 'utf8',
    env: {
      ...process.env,
      NASSAJ_TEST_TEMP_ROOT: tempParent,
      HOME: '/home/operator',
      CLAUDE_CONFIG_DIR: '/home/operator/.nassaj-users/1/.claude',
      NASSAJ_COORDINATOR_REPO_ROOT: '/home/operator/repo',
      WORKSPACES_ROOT: '/home/operator/workspaces',
      CODEX_HOME: '/home/operator/.codex',
      NASSAJ_TEST_PROBE_KNOB: 'kept',
    },
  });
  assert.equal(result.status, 0, result.stderr);
  // The TAP reporter (the release gate sets --test-reporter=tap) prints the
  // probe's console line as a `# ` diagnostic; spec prints it bare.
  const line = result.stdout.split('\n').map(row => row.replace(/^\s*#\s*/u, ''))
    .find(row => row.startsWith('RUNNER_ENV_PROBE '));
  assert.ok(line, result.stdout);
  const seen = JSON.parse(line.slice('RUNNER_ENV_PROBE '.length));
  const runRootPrefix = path.join(tempParent, 'nassaj-server-tests-');
  assert.ok(seen.homedir.startsWith(runRootPrefix), seen.homedir);
  assert.equal(seen.claudeConfigDir, path.join(seen.homedir, '.claude'));
  const caseRoot = path.dirname(seen.homedir);
  assert.equal(seen.databasePath, path.join(caseRoot, 'auth.db'));
  assert.equal(seen.harnessDataHome, caseRoot);
  assert.notEqual(seen.tmpdir, seen.homedir);
  assert.equal(seen.coordinatorRoot, null);
  assert.equal(seen.workspacesRoot, process.cwd());
  assert.equal(seen.codexHome, null);
  assert.equal(seen.testKnob, 'kept');
});
