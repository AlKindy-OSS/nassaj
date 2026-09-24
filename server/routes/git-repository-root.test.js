/**
 * B-1291 coverage: the push reminder must distinguish a project folder that is
 * its own git repository root from a nested subfolder that git resolves upward
 * to an ancestor repository (e.g. project folders under a home directory that
 * happens to be a git repo). `isProjectRepositoryRoot` is the narrow check that
 * gates the reminder; `validateGitRepository` still accepts nested folders for
 * the git panel, so this behaviour is tested here in isolation.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { execFileSync } from 'node:child_process';

import { isProjectRepositoryRoot } from './git.js';

function scratch(t) {
  const parent = process.env.TMPDIR || '/var/tmp';
  const root = fs.mkdtempSync(path.join(parent, 'nassaj-repo-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return fs.realpathSync(root);
}

function initRepo(dir) {
  execFileSync('git', ['init', '-q'], { cwd: dir });
}

test('the repository root itself reports true', async (t) => {
  const root = scratch(t);
  initRepo(root);
  assert.equal(await isProjectRepositoryRoot(root), true);
});

test('a nested subfolder of a repo reports false (the home-repo bug)', async (t) => {
  const root = scratch(t);
  initRepo(root);
  const nested = path.join(root, 'projects', 'Accounting');
  fs.mkdirSync(nested, { recursive: true });
  // git resolves the subfolder upward to `root`, so it is inside a work tree
  // but is NOT its own root: the reminder must stay hidden here.
  assert.equal(await isProjectRepositoryRoot(nested), false);
});

test('a symlink to the repository root still reports true (realpath compared)', async (t) => {
  const root = scratch(t);
  initRepo(root);
  const link = path.join(path.dirname(root), `${path.basename(root)}-link`);
  fs.symlinkSync(root, link);
  t.after(() => fs.rmSync(link, { force: true }));
  assert.equal(await isProjectRepositoryRoot(link), true);
});

test('a directory that is not inside any git repo reports false', async (t) => {
  const root = scratch(t);
  const plain = path.join(root, 'not-a-repo');
  fs.mkdirSync(plain);
  assert.equal(await isProjectRepositoryRoot(plain), false);
});

test('a non-existent path reports false (fails closed)', async (t) => {
  const root = scratch(t);
  assert.equal(await isProjectRepositoryRoot(path.join(root, 'missing')), false);
});
