// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
// eslint-disable-next-line import-x/order -- must evaluate before every other import
import { SANDBOX_HOME } from '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { installFakeHarnessBinary } from '@/shared/__tests__/harness-binary-fixtures.js';

import { writeCodexMachineRelease } from './__tests__/harness-world.js';
import { makeFixtureRoot, removeFixture, writeFixtureFile } from './snapshot/__tests__/fixtures.js';
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

test('qwen is the npm-prefix harness: measured prefix + package, global reinstall argv', () => {
  const npmHarnesses = Object.values(HARNESS_UPDATE_DESCRIPTORS).filter((d) => d.installMethod === 'npm-prefix');
  assert.deepEqual(npmHarnesses.map((d) => d.id), ['qwen']);
  const qwen = HARNESS_UPDATE_DESCRIPTORS.qwen;
  assert.equal(qwen.npm?.pkg, '@qwen-code/qwen-code');
  const argv = qwen.updateArgv()!;
  assert.equal(argv.cmd, 'npm');
  assert.ok(argv.args.includes('@qwen-code/qwen-code@latest'));
  assert.ok(argv.args.includes('--global') && argv.args.includes('--prefix'));
});

test('the npm update carries TMPDIR=/var/tmp — /tmp here is tmpfs (RAM)', () => {
  assert.equal(NPM_UPDATE_TMPDIR, '/var/tmp');
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.qwen.updateArgv()!.env?.TMPDIR, '/var/tmp');
  // The spawn-level proof lives in update.service.spawn-env.test.ts.
});

test('kimi is the official native install: single-file snapshot, `kimi update --yes`', () => {
  const kimi = HARNESS_UPDATE_DESCRIPTORS.kimi;
  assert.equal(kimi.installMethod, 'native-self-update');
  assert.equal(kimi.npm, undefined);
  assert.equal(kimi.manualOnly, true);
  assert.deepEqual(
    { layout: kimi.snapshot?.layout, linkMode: kimi.snapshot?.linkMode },
    { layout: 'single-file', linkMode: 'copy' },
  );
  assert.deepEqual(kimi.notices, { dataNotBackedUp: true, selfUpdating: true });
  const bin = installFakeHarnessBinary(SANDBOX_HOME, 'kimi');
  assert.equal(bin, path.join(SANDBOX_HOME, '.kimi-code', 'bin', 'kimi'));
  assert.deepEqual(kimi.updateArgv(), { cmd: bin, args: ['update', '--yes'] });
  assert.equal(kimi.updateArgv()!.env, undefined, 'a native update stages nothing in TMPDIR');
});

/** Sets (or clears) one server-process env var for the duration of `fn`. */
function withServerEnv<T>(key: string, value: string | undefined, fn: () => T): T {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    return fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
}

test('native self-updaters use their own update/upgrade subcommand', () => {
  // T-1873: the registry only resolves installed CLIs (test HOME = case dir).
  for (const id of ['claude', 'antigravity', 'cursor', 'opencode'] as const) installFakeHarnessBinary(SANDBOX_HOME, id);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.claude.updateArgv()!.args, ['update']);
  // codex derives its install env from the launcher; no standalone launcher → no argv.
  assert.equal(withServerEnv('CODEX_PATH', '/nonexistent/codex', () => HARNESS_UPDATE_DESCRIPTORS.codex.updateArgv()), null);
  const root = makeFixtureRoot();
  try {
    const standalone = path.join(root, '.codex', 'packages', 'standalone');
    // T-1873: the registry codex is T-1872's validated machine release.
    writeCodexMachineRelease(path.join(standalone, 'releases', '1.0.0'), '1.0.0');
    fs.symlinkSync(path.join(standalone, 'releases', '1.0.0'), path.join(standalone, 'current'));
    const bin = path.join(root, 'bin', 'codex');
    fs.mkdirSync(path.dirname(bin));
    fs.symlinkSync(path.join(standalone, 'current', 'bin', 'codex'), bin);
    const argv = withServerEnv('CODEX_PATH', bin, () => HARNESS_UPDATE_DESCRIPTORS.codex.updateArgv())!;
    assert.deepEqual(argv.args, ['update']);
    assert.deepEqual(argv.env, { CODEX_HOME: path.join(root, '.codex'), CODEX_INSTALL_DIR: path.dirname(bin) });
  } finally {
    removeFixture(root);
  }
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.antigravity.updateArgv()!.args, ['update']);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.cursor.updateArgv()!.args, ['update']);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.opencode.updateArgv()!.args, ['upgrade']);
});

test('claude update resolves the exact SDK launch binary (server CLAUDE_CLI_PATH)', () => {
  const root = makeFixtureRoot();
  try {
    const custom = path.join(root, 'opt', 'claude');
    writeFixtureFile(custom, '#!/bin/sh\n', 0o755);
    const argv = withServerEnv('CLAUDE_CLI_PATH', custom, () => HARNESS_UPDATE_DESCRIPTORS.claude.updateArgv());
    assert.equal(argv?.cmd, custom);
  } finally {
    removeFixture(root);
  }
});

test('an uninstalled native harness has no update target', () => {
  withServerEnv('AGY_PATH', '/nonexistent/agy', () => {
    assert.equal(HARNESS_UPDATE_DESCRIPTORS.antigravity.updateArgv(), null);
  });
});

test('verified built-in auto-updater disable knobs (D2): claude + opencode + kimi', () => {
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.claude.disableAutoUpdaterEnv, { DISABLE_AUTOUPDATER: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.claude.autoUpdaterDisableVerified, true);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.opencode.disableAutoUpdaterEnv, { OPENCODE_DISABLE_AUTOUPDATE: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.opencode.autoUpdaterDisableVerified, true);
  // T-1873: kimi-code's own kill switch, wired for every kimi child.
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.kimi.disableAutoUpdaterEnv, { KIMI_CODE_NO_AUTO_UPDATE: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.kimi.autoUpdaterDisableVerified, true);
});

test('AUTOUPDATER_DISABLE_NONE lists only harnesses with no verified knob', () => {
  assert.ok(AUTOUPDATER_DISABLE_NONE.includes('codex'));
  assert.ok(AUTOUPDATER_DISABLE_NONE.includes('qwen'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('kimi'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('claude'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('opencode'));
});

test('every descriptor is keyed by its own id', () => {
  for (const id of HARNESS_IDS) {
    assert.equal(HARNESS_UPDATE_DESCRIPTORS[id].id, id);
  }
});
