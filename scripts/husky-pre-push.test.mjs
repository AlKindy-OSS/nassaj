/**
 * T-2095: .husky/pre-push refuses to publish private nassaj refs (turn
 * checkpoints, session requests) while the release push
 * `git push --atomic origin main <tag>` still goes through.
 */
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOOK = path.join(REPO_ROOT, '.husky', 'pre-push');
const TEMP_PARENT = process.env.NASSAJ_TEST_TMP || '/var/tmp';

function git(cwd, ...args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: 'pipe' }).trim();
}

function fixture() {
  const root = fs.mkdtempSync(path.join(TEMP_PARENT, 'nassaj-pre-push-'));
  const remote = path.join(root, 'remote.git');
  const local = path.join(root, 'local');
  const hooks = path.join(root, 'hooks');
  execFileSync('git', ['init', '-q', '--bare', remote]);
  execFileSync('git', ['init', '-q', '-b', 'main', local]);
  git(local, 'config', 'user.name', 'Pre Push');
  git(local, 'config', 'user.email', 'pre-push@example.test');
  fs.mkdirSync(hooks);
  // Same invocation as husky's wrapper: `sh -e .husky/pre-push "$@"`.
  fs.writeFileSync(path.join(hooks, 'pre-push'), `#!/bin/sh\nexec sh -e "${HOOK}" "$@"\n`, { mode: 0o755 });
  git(local, 'config', 'core.hooksPath', hooks);
  fs.writeFileSync(path.join(local, 'a.txt'), 'a\n');
  git(local, 'add', 'a.txt');
  git(local, 'commit', '-q', '-m', 'chore: init');
  git(local, 'remote', 'add', 'origin', remote);
  return { root, local, remote };
}

function push(local, ...refspecs) {
  return spawnSync('git', ['-C', local, 'push', '-q', ...refspecs], { encoding: 'utf8' });
}

test('the release push of main and its tag is allowed', () => {
  const { root, local, remote } = fixture();
  try {
    git(local, 'tag', '-a', 'v9.9.9', '-m', 'release v9.9.9');
    const result = push(local, '--atomic', 'origin', 'main', 'v9.9.9');
    assert.equal(result.status, 0, result.stderr);
    assert.equal(git(remote, 'rev-parse', 'refs/tags/v9.9.9^{commit}'), git(local, 'rev-parse', 'HEAD'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a local refs/nassaj ref is refused', () => {
  const { root, local, remote } = fixture();
  try {
    git(local, 'update-ref', 'refs/nassaj/x', 'HEAD');
    const result = push(local, 'origin', 'refs/nassaj/x:refs/heads/leak');
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /private ref/);
    assert.equal(spawnSync('git', ['-C', remote, 'rev-parse', '--verify', '--quiet', 'refs/heads/leak']).status, 1);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a push onto a remote refs/nassaj or refs/checkpoints ref is refused', () => {
  const { root, local } = fixture();
  try {
    for (const target of ['refs/nassaj/y', 'refs/nassaj-update/z', 'refs/checkpoints/00000001/post']) {
      const result = push(local, 'origin', `main:${target}`);
      assert.notEqual(result.status, 0, target);
    }
    const atomic = push(local, '--atomic', 'origin', 'main', 'main:refs/nassaj/mixed');
    assert.notEqual(atomic.status, 0, 'one private ref fails the whole atomic push');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
