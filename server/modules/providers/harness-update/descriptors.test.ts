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
  deriveHarnessNotices,
  getHarnessDescriptor,
  HARNESS_IDS,
  HARNESS_UPDATE_DESCRIPTORS,
  NPM_UPDATE_TMPDIR,
  parseVersionOutput,
  resolveHarnessId,
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
    parseVersionOutput('Some Agent v0.17.0 (2026.6.19) · local 5ecf3bf0'),
    '0.17.0',
  );
  assert.equal(parseVersionOutput(''), null);
  assert.equal(parseVersionOutput('no version here'), null);
  assert.equal(parseVersionOutput(undefined), null);
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

test('the npm update carries TMPDIR=/var/tmp — /tmp here is tmpfs (RAM)', () => {
  assert.equal(NPM_UPDATE_TMPDIR, '/var/tmp');
  // The spawn-level proof lives in update.service.spawn-env.test.ts.
});

test('no harness is an npm-prefix install any more (qwen removed, ADR-229)', () => {
  const npmPrefix = Object.values(HARNESS_UPDATE_DESCRIPTORS).filter((d) => d.installMethod === 'npm-prefix');
  assert.deepEqual(npmPrefix.map((d) => d.id), []);
  assert.equal(getHarnessDescriptor('qwen'), null);
  assert.equal(getHarnessDescriptor('kimi'), null);
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

test('verified built-in auto-updater disable knobs (D2): claude + opencode', () => {
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.claude.disableAutoUpdaterEnv, { DISABLE_AUTOUPDATER: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.claude.autoUpdaterDisableVerified, true);
  assert.deepEqual(HARNESS_UPDATE_DESCRIPTORS.opencode.disableAutoUpdaterEnv, { OPENCODE_DISABLE_AUTOUPDATE: '1' });
  assert.equal(HARNESS_UPDATE_DESCRIPTORS.opencode.autoUpdaterDisableVerified, true);
});

test('AUTOUPDATER_DISABLE_NONE lists only harnesses with no verified knob', () => {
  assert.ok(AUTOUPDATER_DISABLE_NONE.includes('codex'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('claude'));
  assert.ok(!AUTOUPDATER_DISABLE_NONE.includes('opencode'));
});

test('dsh (T-2086 S4) is the npm-lock harness: button-only, reviewed pin, `npm ci` never @latest', () => {
  const d = HARNESS_UPDATE_DESCRIPTORS.dsh;
  assert.equal(d.installMethod, 'npm-lock');
  assert.equal(d.manualOnly, true);
  assert.equal(d.autoUpdaterDisableVerified, true);
  assert.deepEqual(d.runProviders, ['dsh']);
  assert.deepEqual(d.latestProbe, { kind: 'reviewed-pin', publishedPkg: '@deepseek-ai/dsh' });
  const argv = d.updateArgv();
  assert.ok(argv);
  assert.equal(argv.args[1], 'ci');
  assert.ok(argv.args.includes('--ignore-scripts'));
  assert.ok(!argv.args.some((a) => a.includes('@latest') || a === 'install' || a.includes('@deepseek-ai/dsh')));
  assert.equal(argv.env?.TMPDIR, '/var/tmp');
  assert.ok(argv.cwd?.endsWith(path.join('.local', 'share', 'dsh', 'versions', '.staging-0.2.2-rc.1')), argv.cwd);
});

test('every descriptor is keyed by its own id', () => {
  for (const id of HARNESS_IDS) {
    assert.equal(HARNESS_UPDATE_DESCRIPTORS[id].id, id);
  }
});

/** The dialog facts every harness must carry; a new harness must be listed here. */
const EXPECTED_NOTICES: Record<string, { dataNotBackedUp: boolean; selfUpdating: boolean } | null> = {
  claude: { dataNotBackedUp: true, selfUpdating: false },
  codex: { dataNotBackedUp: false, selfUpdating: true },
  antigravity: { dataNotBackedUp: true, selfUpdating: true },
  cursor: { dataNotBackedUp: true, selfUpdating: true },
  opencode: null,
  // dsh: member data (~/.dsh per member) is not copied; no self-updater (S0).
  dsh: { dataNotBackedUp: true, selfUpdating: false },
  glm: null,
  deepseek: null,
};

test('notices are derived from each descriptor\'s facts, for every harness (parity guard)', () => {
  assert.deepEqual([...HARNESS_IDS].sort(), Object.keys(EXPECTED_NOTICES).sort(),
    'every harness lists its expected notices');
  for (const d of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    const notices = deriveHarnessNotices(d);
    assert.deepEqual(notices, EXPECTED_NOTICES[d.id], d.id);
    assert.equal('notices' in d, false, `${d.id}: notices are never hand-set`);
    if (!d.updatable) {
      assert.equal(notices, null, `${d.id}: no update, no warning`);
      continue;
    }
    const noStore = (d.snapshot?.stores.length ?? 0) === 0;
    assert.equal(notices?.dataNotBackedUp ?? false, noStore, `${d.id}: dataNotBackedUp`);
    assert.equal(notices?.selfUpdating ?? false, !d.autoUpdaterDisableVerified, `${d.id}: selfUpdating`);
  }
});
