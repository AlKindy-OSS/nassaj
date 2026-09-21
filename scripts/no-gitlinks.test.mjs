#!/usr/bin/env node
/**
 * G1 (ADR-156) as a permanent gate: `npm run test:scripts` collects this file,
 * and release.yml runs that script, so a gitlink cannot reach a release through
 * a workflow that never fires. The live repository is checked first, then the
 * detector is proven against a tree that actually carries a violation.
 */
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import { assertNoGitlinks, gitlinkViolations, stagedGitlinks } from './no-gitlinks.mjs';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FOREIGN_COMMIT = '0123456789012345678901234567890123456789';

function run(cwd, args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function fixture(t) {
  const root = mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'no-gitlinks-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  run(root, ['init']);
  run(root, ['config', 'user.email', 'gitlinks@example.test']);
  run(root, ['config', 'user.name', 'Gitlink Test']);
  writeFileSync(path.join(root, 'README.md'), 'fixture\n');
  run(root, ['add', 'README.md']);
  run(root, ['commit', '-m', 'fixture']);
  return root;
}

test('this repository carries no gitlink and no .gitmodules', () => {
  assert.deepEqual(gitlinkViolations(REPOSITORY_ROOT), []);
  assert.deepEqual(assertNoGitlinks(REPOSITORY_ROOT), { ok: true, root: REPOSITORY_ROOT });
});

test('a staged 160000 entry is reported and fails closed', (t) => {
  const root = fixture(t);
  run(root, ['update-index', '--add', '--cacheinfo', `160000,${FOREIGN_COMMIT},plugins/starter`]);
  assert.deepEqual(stagedGitlinks(root), ['plugins/starter']);
  assert.deepEqual(gitlinkViolations(root), ['staged gitlink: plugins/starter']);
  assert.throws(() => assertNoGitlinks(root), /ADR-156 G1 — staged gitlink: plugins\/starter/);
});

test('a tracked .gitmodules fails even when it is the empty blob', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.gitmodules'), '');
  run(root, ['add', '--', '.gitmodules']);
  const violations = gitlinkViolations(root);
  assert.equal(violations.length, 2);
  assert.match(violations[0], /^\.gitmodules is tracked: 100644 e69de29[0-9a-f]+ 0$/);
  assert.match(violations[1], /^\.gitmodules exists in the worktree \(0 bytes\)$/);
  assert.throws(() => assertNoGitlinks(root), /ADR-156 G1/);
});

test('an untracked .gitmodules is still a violation', (t) => {
  const root = fixture(t);
  writeFileSync(path.join(root, '.gitmodules'), '[submodule "starter"]\n');
  const violations = gitlinkViolations(root);
  assert.equal(violations.length, 1);
  assert.match(violations[0], /^\.gitmodules exists in the worktree \(\d+ bytes\)$/);
});

test('a clean tree reports nothing', (t) => {
  assert.deepEqual(gitlinkViolations(fixture(t)), []);
});
