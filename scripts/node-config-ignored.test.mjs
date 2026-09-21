#!/usr/bin/env node
/**
 * ADR-156 (د.1): `config/` is the operator-owned node customization directory —
 * `node.env`, `release-source.lock.json`, and later `node-overlay.json` plus
 * `overlay/`. It must be ignored *before* any writer creates it, otherwise the
 * first write turns every later update into a `dirty_worktree` refusal (B-1050),
 * which is the incident this listing exists to prevent.
 */
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/**
 * 0 = ignored, 1 = not ignored; anything else is a git failure, not an answer.
 * The directory is asked about as `config/`: a directory-only pattern does not
 * match a bare name whose type git cannot know.
 */
function checkIgnore(relative) {
  const result = spawnSync('git', ['check-ignore', '-q', '--', relative], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.ok(result.status === 0 || result.status === 1, result.stderr || `git exited ${result.status}`);
  return result.status === 0;
}

test('the node config directory and its files are ignored', () => {
  for (const relative of [
    'config/',
    'config/node.env',
    'config/release-source.lock.json',
    'config/node-overlay.json',
    'config/overlay/server.env',
  ]) {
    assert.equal(checkIgnore(relative), true, `${relative} must be ignored`);
  }
});

test('the listing is anchored to the repository root', () => {
  assert.equal(checkIgnore('src/config/theme.ts'), false);
  assert.equal(checkIgnore('server/config/app.js'), false);
});

test('nothing under the node config directory is tracked', () => {
  const tracked = spawnSync('git', ['ls-files', '-z', '--', 'config'], {
    cwd: REPOSITORY_ROOT,
    encoding: 'utf8',
  });
  assert.equal(tracked.status, 0, tracked.stderr);
  assert.deepEqual(tracked.stdout.split('\0').filter(Boolean), []);
});
