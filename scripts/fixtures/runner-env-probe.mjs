// B-1420 fixture: run by run-isolated-node-tests.test.mjs through the runner; it
// prints the environment a test case actually sees.
import os from 'node:os';

const pick = key => process.env[key] ?? null;
console.log(`RUNNER_ENV_PROBE ${JSON.stringify({
  homedir: os.homedir(),
  tmpdir: os.tmpdir(),
  claudeConfigDir: pick('CLAUDE_CONFIG_DIR'),
  databasePath: pick('DATABASE_PATH'),
  harnessDataHome: pick('NASSAJ_HARNESS_DATA_HOME'),
  coordinatorRoot: pick('NASSAJ_COORDINATOR_REPO_ROOT'),
  workspacesRoot: pick('WORKSPACES_ROOT'),
  codexHome: pick('CODEX_HOME'),
  testKnob: pick('NASSAJ_TEST_PROBE_KNOB'),
})}`);
