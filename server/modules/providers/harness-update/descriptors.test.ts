import assert from 'node:assert/strict';
import test from 'node:test';

import {
  AUTOUPDATER_DISABLE_NONE,
  getHarnessDescriptor,
  HARNESS_IDS,
  HARNESS_UPDATE_DESCRIPTORS,
  NPM_UPDATE_TMPDIR,
  parseVersionOutput,
  resolveHarnessId,
  resolveHermesCheckoutDir,
} from './descriptors.js';

test('resolveHarnessId normalises ids and documented aliases', () => {
  assert.equal(resolveHarnessId('claude'), 'claude');
  assert.equal(resolveHarnessId('AGY'), 'antigravity');
  assert.equal(resolveHarnessId('agy'), 'antigravity');
  assert.equal(resolveHarnessId('cursor-agent'), 'cursor');
  assert.equal(resolveHarnessId(' Cursor '), 'cursor');
  assert.equal(resolveHarnessId('gemini'), null); // removed provider
  assert.equal(resolveHarnessId('nope'), null);
  assert.equal(resolveHarnessId(42 as unknown), null);
});

test('parseVersionOutput handles every measured CLI format', () => {
  assert.equal(parseVersionOutput('1.2.1'), '1.2.1');
  assert.equal(parseVersionOutput('2026.07.23-e383d2b'), '2026.07.23-e383d2b');
  assert.equal(parseVersionOutput('0.42.0\n'), '0.42.0');
  assert.equal(
    parseVersionOutput('Hermes Agent v0.17.0 (2026.6.19) · local 5ecf3bf0'),
    '0.17.0',
  );
  assert.equal(parseVersionOutput(''), null);
  assert.equal(parseVersionOutput('no version here'), null);
  assert.equal(parseVersionOutput(undefined), null);
});

test('hermes IS updatable through the git-shallow path (Addendum 3 supersedes D4)', () => {
  const hermes = getHarnessDescriptor('hermes');
  assert.ok(hermes);
  assert.equal(hermes.state, 'updatable');
  assert.equal(hermes.updatable, true);
  assert.equal(hermes.installMethod, 'git-shallow');
  // Measured on-host: the shallow clone the updater rewrites.
  assert.equal(hermes.gitCheckoutDir, resolveHermesCheckoutDir());

  const argv = hermes.updateArgv();
  assert.ok(argv);
  // `hermes update` = git fetch + reset --hard + uv pip install -e; `--yes` only
  // answers the interactive prompts so the run is headless.
  assert.deepEqual(argv.args, ['update', '--yes']);
  assert.equal(argv.cwd, resolveHermesCheckoutDir(), 'it runs inside the checkout');
  assert.ok(argv.env?.HERMES_HOME, 'HERMES_HOME isolation travels with the argv');
});

test('the hermes checkout dir is overridable by env (host default otherwise)', () => {
  assert.equal(resolveHermesCheckoutDir({ HERMES_CHECKOUT_DIR: '/srv/hermes' }), '/srv/hermes');
  assert.ok(resolveHermesCheckoutDir({}).endsWith('/.hermes/hermes-agent'));
});

test('glm and deepseek are no-cli, not updatable', () => {
  for (const id of ['glm', 'deepseek']) {
    const d = getHarnessDescriptor(id);
    assert.ok(d);
    assert.equal(d.state, 'no-cli');
    assert.equal(d.updatable, false);
  }
  assert.equal(getHarnessDescriptor('glm')!.reason, 'updates with opencode');
});

test('opencode carries the glm run id for the live-session gate', () => {
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.opencode.runProviders, ['opencode', 'glm']);
});

test('npm-prefix harnesses carry a measured prefix + package and fixed reinstall argv', () => {
  const kimi = HARNESS_UPDATE_DESCRIPTORS.kimi;
  assert.equal(kimi.installMethod, 'npm-prefix');
  assert.equal(kimi.npm?.pkg, '@moonshot-ai/kimi-code');
  const kArgv = kimi.updateArgv();
  assert.ok(kArgv);
  assert.equal(kArgv.cmd, 'npm');
  assert.ok(kArgv.args.includes('@moonshot-ai/kimi-code@latest'));
  assert.ok(kArgv.args.includes('--prefix'));

  const qwen = HARNESS_UPDATE_DESCRIPTORS.qwen;
  assert.equal(qwen.npm?.pkg, '@qwen-code/qwen-code');
  assert.ok(qwen.updateArgv()!.args.includes('@qwen-code/qwen-code@latest'));
});

test('both npm updates carry TMPDIR=/var/tmp — /tmp here is tmpfs (RAM)', () => {
  assert.equal(NPM_UPDATE_TMPDIR, '/var/tmp');
  for (const id of ['kimi', 'qwen'] as const) {
    assert.equal(
      HARNESS_UPDATE_DESCRIPTORS[id].updateArgv()!.env?.TMPDIR,
      '/var/tmp',
      `${id} stages its npm tarball outside tmpfs`,
    );
  }
  // The spawn-level proof lives in update.service.spawn-env.test.ts.
});

test('native self-updaters use their own update/upgrade subcommand', () => {
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.claude.updateArgv()!.args, ['update']);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.codex.updateArgv()!.args, ['update']);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.antigravity.updateArgv()!.args, ['update']);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.cursor.updateArgv()!.args, ['update']);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.opencode.updateArgv()!.args, ['upgrade']);
});

test('claude update resolves the exact SDK launch binary', () => {
  const argv = HARNESS_UPDATE_DESCRIPTORS.claude.updateArgv({
    CLAUDE_CLI_PATH: '/opt/operator/bin/claude',
  });
  assert.equal(argv?.cmd, '/opt/operator/bin/claude');
});

test('verified built-in auto-updater disable knobs (D2): claude + opencode', () => {
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.claude.disableAutoUpdaterEnv, { DISABLE_AUTOUPDATER: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.claude.autoUpdaterDisableVerified, true);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.opencode.disableAutoUpdaterEnv, { OPENCODE_DISABLE_AUTOUPDATE: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.opencode.autoUpdaterDisableVerified, true);
});

test('AUTOUPDATER_DISABLE_NONE lists only harnesses with no verified knob', () => {
  assert.ok(AUTOUPDATER_DISABLE_NONE.includes('codex'));
  assert.ok(AUTOUPDATER_DISABLE_NONE.includes('qwen'));
  assert.ok(AUTOUPDATER_DISABLE_NONE.includes('kimi'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('claude'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('opencode'));
});

test('every descriptor is keyed by its own id', () => {
  for (const id of HARNESS_IDS) {
    assert.equal(HARNESS_UPDATE_DESCRIPTORS[id].id, id);
  }
});
