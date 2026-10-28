/**
 * B-1691 (qa F2/F12): git children spawned by the git routes run with the shared
 * hardening of shared/git-safety.js.
 *   - F2: a bare repository planted at a project root through the file API is
 *     refused (safe.bareRepository=explicit), so its `core.fsmonitor` command
 *     never runs as the service.
 *   - F12 (owner decision): read-only verbs run without hooks; commit, push,
 *     pull/merge and checkout keep the project's own hooks.
 *
 * Uses a real git and real directories under /var/tmp (no repository above them).
 */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';

import {
  GIT_READ_ONLY_ARGS,
  GIT_SAFE_CONFIG_ARGS,
  gitHardeningArgs,
  isReadOnlyGitInvocation,
} from '../../shared/git-safety.js';
import { spawnAsync, validateFilePath } from './git.js';

function scratch(t, prefix) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join('/var/tmp', prefix)));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function plantBareRepository(t) {
  const root = scratch(t, 'git-bare-plant-');
  fs.mkdirSync(path.join(root, 'objects'));
  fs.mkdirSync(path.join(root, 'refs', 'heads'), { recursive: true });
  fs.writeFileSync(path.join(root, 'HEAD'), 'ref: refs/heads/main\n');
  const marker = path.join(root, 'PWNED');
  fs.writeFileSync(path.join(root, 'config'),
    `[core]\n\trepositoryformatversion = 0\n\tworktree = .\n\tfsmonitor = "touch ${marker}; false"\n`);
  fs.writeFileSync(path.join(root, 'a.txt'), 'x\n');
  return { root, marker };
}

/** A real repository with one commit and a hook that leaves a marker file. */
function repositoryWithHook(t, hookName) {
  const root = scratch(t, 'git-hook-repo-');
  const git = (...args) => execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...args],
    { cwd: root, stdio: 'ignore' });
  git('init', '-q');
  fs.writeFileSync(path.join(root, 'f.txt'), 'one\n');
  git('add', 'f.txt');
  git('commit', '-q', '-m', 'init');
  const marker = path.join(root, `${hookName}.ran`);
  const hook = path.join(root, '.git', 'hooks', hookName);
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`);
  fs.chmodSync(hook, 0o755);
  return { root, marker };
}

test('control: plain git runs the planted fsmonitor command', (t) => {
  const { root, marker } = plantBareRepository(t);
  execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: 'ignore' });
  assert.equal(fs.existsSync(marker), true, 'the plant is live, so the next test is meaningful');
});

test('spawnAsync refuses the planted bare repository and never runs its command', async (t) => {
  const { root, marker } = plantBareRepository(t);
  await assert.rejects(spawnAsync('git', ['status', '--porcelain'], { cwd: root }), (error) => {
    assert.match(error.stderr, /safe\.bareRepository/);
    return true;
  });
  await assert.rejects(spawnAsync('git', ['commit', '--allow-empty', '-m', 'x'], { cwd: root }));
  assert.equal(fs.existsSync(marker), false, 'the fsmonitor command did not execute');
});

test('F12: a read-only status runs no hook (control: plain git runs it)', async (t) => {
  const { root, marker } = repositoryWithHook(t, 'post-index-change');
  const stale = new Date('2001-01-01T00:00:00Z');
  fs.utimesSync(path.join(root, 'f.txt'), stale, stale);
  execFileSync('git', ['status', '--porcelain'], { cwd: root, stdio: 'ignore' });
  assert.equal(fs.existsSync(marker), true, 'control: git status refreshes the index and runs the hook');
  fs.rmSync(marker);

  const older = new Date('2000-01-01T00:00:00Z');
  fs.utimesSync(path.join(root, 'f.txt'), older, older);
  await spawnAsync('git', ['status', '--porcelain'], { cwd: root });
  await spawnAsync('git', ['diff', '--', 'f.txt'], { cwd: root });
  assert.equal(fs.existsSync(marker), false, 'no hook ran for status/diff');
});

test('F12: a panel commit keeps the project pre-commit hook', async (t) => {
  const { root, marker } = repositoryWithHook(t, 'pre-commit');
  fs.writeFileSync(path.join(root, 'f.txt'), 'two\n');
  await spawnAsync('git', ['add', 'f.txt'], { cwd: root });
  await spawnAsync('git', ['commit', '-m', 'fix: two'], {
    cwd: root,
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid',
      GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' },
  });
  assert.equal(fs.existsSync(marker), true, 'the pre-commit hook ran');
});

test('F12: read-only verbs get the no-hooks prefix; writes keep hooks', () => {
  for (const args of [
    ['status', '--porcelain'], ['diff', '--', 'a'], ['log', '-1'], ['show', 'HEAD:a'], ['rev-parse', 'HEAD'],
    ['ls-files'], ['cat-file', '-p', 'HEAD'], ['for-each-ref'], ['branch', '-a'], ['branch', '--show-current'],
    ['remote'], ['remote', 'get-url', 'origin'], ['config', '--get', 'x.y'], ['symbolic-ref', '--short', 'HEAD'],
    ['-C', '/r', 'log', '-1'],
  ]) {
    assert.equal(isReadOnlyGitInvocation(args), true, args.join(' '));
    assert.deepEqual(gitHardeningArgs(args), GIT_READ_ONLY_ARGS, args.join(' '));
  }
  for (const args of [
    ['commit', '-m', 'x'], ['push', 'origin', 'main'], ['pull', 'origin', 'main'], ['merge', 'x'],
    ['checkout', 'main'], ['checkout', '-b', 'x'], ['branch', '-d', 'x'], ['branch', 'new'], ['update-ref', '--stdin'],
    ['config', 'branch.x.remote', 'origin'], ['symbolic-ref', 'HEAD', 'refs/heads/x'], ['-C', '/r', 'update-ref', '-d', 'r'],
  ]) {
    assert.equal(isReadOnlyGitInvocation(args), false, args.join(' '));
    assert.deepEqual(gitHardeningArgs(args), GIT_SAFE_CONFIG_ARGS, args.join(' '));
  }
  assert.deepEqual([...GIT_SAFE_CONFIG_ARGS], ['-c', 'core.fsmonitor=false', '-c', 'safe.bareRepository=explicit']);
  assert.deepEqual([...GIT_READ_ONLY_ARGS], [...GIT_SAFE_CONFIG_ARGS, '-c', 'core.hooksPath=/dev/null']);
});

test('qa F8: validateFilePath refuses a root inside .git unless it is a trusted overlay', (t) => {
  const { root } = repositoryWithHook(t, 'pre-commit');
  const legacy = path.join(root, '.git');
  const overlay = path.join(legacy, 'nassaj-session-overlays', 'instances', 'x', 'workspace');
  fs.mkdirSync(overlay, { recursive: true });
  fs.writeFileSync(path.join(overlay, 'a.txt'), 'a\n');
  const silenced = console.warn;
  console.warn = () => {};
  try {
    assert.throws(() => validateFilePath('config', legacy), /path traversal/);
    assert.throws(() => validateFilePath('hooks/pre-commit', legacy), /path traversal/);
    assert.throws(() => validateFilePath('a.txt', overlay), /path traversal/, 'shape alone never exempts');
    assert.equal(validateFilePath('a.txt', overlay, { trustedOverlayRoot: true }), 'a.txt');
    assert.equal(validateFilePath('f.txt', root), 'f.txt');
  } finally {
    console.warn = silenced;
  }
});
