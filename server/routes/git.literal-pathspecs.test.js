/**
 * The git router validates a client path literally (`.en?` names no file, so
 * the path guard passes it), then hands it to git as a pathspec. Without
 * literal mode git expands `?`/`*`/`:(glob)` and the diff covers the tracked
 * `.env`. spawnAsync must run every git child with GIT_LITERAL_PATHSPECS=1.
 *
 * Uses a real repository under /var/tmp.
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import { spawnAsync } from './git.js';

function scratchRepo(t) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', 'git-literal-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: root, env: { ...process.env, GIT_LITERAL_PATHSPECS: '0' } });
  git('init', '-q');
  fs.writeFileSync(path.join(root, '.env'), 'JWT_SECRET=old\n');
  git('add', '.env');
  git('commit', '-q', '-m', 'init');
  fs.writeFileSync(path.join(root, '.env'), 'JWT_SECRET=s3cret\n');
  return root;
}

test('glob pathspecs do not reach a different file through spawnAsync', async (t) => {
  const root = scratchRepo(t);
  // Control: plain git with magic pathspecs DOES match .env via `.en?`.
  const magic = execFileSync('git', ['diff', '--', '.en?'], {
    cwd: root, encoding: 'utf8', env: { ...process.env, GIT_LITERAL_PATHSPECS: '0' },
  });
  assert.match(magic, /s3cret/, 'control: magic pathspec matches .env');

  for (const pathspec of ['.en?', '.e*', ':(glob).env*', ':(icase).ENV']) {
    const status = await spawnAsync('git', ['status', '--porcelain', '--', pathspec], { cwd: root });
    assert.equal(status.stdout, '', pathspec);
    const diff = await spawnAsync('git', ['diff', '--', pathspec], { cwd: root });
    assert.equal(diff.stdout.includes('s3cret'), false, pathspec);
  }
});

test('a literal path still works through spawnAsync', async (t) => {
  const root = scratchRepo(t);
  fs.writeFileSync(path.join(root, 'README.md'), 'hello\n');
  const status = await spawnAsync('git', ['status', '--porcelain', '--', 'README.md'], { cwd: root });
  assert.equal(status.stdout.trim(), '?? README.md');
});
