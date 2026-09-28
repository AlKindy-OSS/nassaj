/**
 * T-1871 stage 3b — per-harness layouts derived from the launcher (fixtures
 * shaped like the measured host) and the derived codex update env.
 */

// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, test } from 'node:test';

import { hasErrorCode } from './snapshot/errors.js';
import { makeFixtureRoot, removeFixture, writeFixtureFile } from './snapshot/__tests__/fixtures.js';
import {
  claudeLayout,
  codexLayout,
  codexUpdateEnv,
  cursorLayout,
  singleFileLayout,
} from './snapshot-layouts.js';

const root = makeFixtureRoot();
after(() => removeFixture(root));
const mismatch = (e: unknown) => hasErrorCode(e, 'SNAPSHOT_LAYOUT_MISMATCH');

function link(target: string, at: string): string {
  fs.mkdirSync(path.dirname(at), { recursive: true });
  fs.symlinkSync(target, at);
  return at;
}

test('claude: versions/<v> file behind the launcher link', () => {
  const v = path.join(root, 'claude', 'versions', '2.1.280');
  writeFixtureFile(v, 'x', 0o755);
  const bin = link(v, path.join(root, 'claude', 'bin', 'claude'));
  assert.deepEqual(claudeLayout(bin), {
    layout: 'versioned-file', linkMode: 'hardlink', binaryPath: bin, versionsDir: path.dirname(v), symlinks: [bin],
  });
  assert.throws(() => claudeLayout(v), mismatch, 'a plain file launcher is not the measured layout');
  assert.throws(() => claudeLayout('claude'), mismatch, 'a bare name is refused');
});

test('cursor: versions/<v>/cursor-agent behind the launcher link', () => {
  const exe = path.join(root, 'cursor', 'versions', '2026.09.18-9a7762b', 'cursor-agent');
  writeFixtureFile(exe, 'x', 0o755);
  const bin = link(exe, path.join(root, 'cursor', 'bin', 'cursor-agent'));
  assert.equal(cursorLayout(bin).versionsDir, path.join(root, 'cursor', 'versions'));
  assert.equal(cursorLayout(bin).layout, 'versioned-dir');
  const dangling = link(path.join(root, 'nope'), path.join(root, 'cursor', 'bin', 'dangling'));
  assert.throws(() => cursorLayout(dangling), mismatch);
});

test('codex: CODEX_HOME + install dir derived from the launcher; current swapped before the launcher', () => {
  const home = path.join(root, 'codex-home', '.nassaj-users', '1', '.codex');
  const standalone = path.join(home, 'packages', 'standalone');
  writeFixtureFile(path.join(standalone, 'releases', '0.156.0', 'bin', 'codex'), 'x', 0o755);
  link(path.join(standalone, 'releases', '0.156.0'), path.join(standalone, 'current'));
  const bin = link(path.join(standalone, 'current', 'bin', 'codex'), path.join(root, 'codex-home', '.local', 'bin', 'codex'));
  assert.deepEqual(codexUpdateEnv(bin), { CODEX_HOME: home, CODEX_INSTALL_DIR: path.dirname(bin) });
  const layout = codexLayout(bin);
  assert.equal(layout.versionsDir, path.join(standalone, 'releases'));
  assert.deepEqual(layout.symlinks, [path.join(standalone, 'current'), bin]);
  const direct = link(path.join(standalone, 'releases', '0.156.0', 'bin', 'codex'), path.join(root, 'codex-direct', 'codex'));
  assert.throws(() => codexUpdateEnv(direct), mismatch, 'a launcher that bypasses `current` is refused');
});

test('single-file: a regular file only (agy / opencode)', () => {
  const file = path.join(root, 'single', 'agy');
  writeFixtureFile(file, 'x', 0o755);
  assert.deepEqual(singleFileLayout(file), { layout: 'single-file', linkMode: 'copy', binaryPath: file, symlinks: [] });
  const viaLink = link(file, path.join(root, 'single', 'agy-link'));
  assert.throws(() => singleFileLayout(viaLink), mismatch);
  assert.throws(() => singleFileLayout(path.join(root, 'single', 'missing')), mismatch);
});
