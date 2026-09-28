import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, test } from 'node:test';

/**
 * B-1358: validateWorkspacePath must resolve symlinks through EVERY existing
 * ancestor, not just the immediate parent, and reject dangling links, because
 * callers `mkdir -p` the literal path and would follow a link outside the root.
 */

const fixtureParent = fs.mkdtempSync(path.join('/var/tmp', 'b1358-ws-'));
const workspaceRoot = path.join(fixtureParent, 'ws');
const outsideDir = path.join(fixtureParent, 'outside');
process.env.WORKSPACES_ROOT = workspaceRoot;

const { validateWorkspacePath, realpathThroughMissingSegments } = await import('@/shared/utils.js');

before(() => {
  fs.mkdirSync(path.join(workspaceRoot, 'real', 'existing'), { recursive: true });
  fs.mkdirSync(outsideDir, { recursive: true });
  fs.symlinkSync(outsideDir, path.join(workspaceRoot, 'link'));
  fs.symlinkSync(path.join(fixtureParent, 'nowhere'), path.join(workspaceRoot, 'dangling'));
  fs.symlinkSync(path.join(workspaceRoot, 'real'), path.join(workspaceRoot, 'in'));
  fs.mkdirSync(path.join(workspaceRoot, 'locked'));
});

after(() => {
  fs.chmodSync(path.join(workspaceRoot, 'locked'), 0o755);
  fs.rmSync(fixtureParent, { recursive: true, force: true });
});

const ws = (...segments: string[]) => path.join(workspaceRoot, ...segments);

test('escape: link->outside with two missing segments is rejected', async () => {
  const result = await validateWorkspacePath(ws('link', 'a', 'b'));
  assert.equal(result.valid, false);
});

test('escape: link->outside with one missing segment is rejected', async () => {
  const result = await validateWorkspacePath(ws('link', 'a'));
  assert.equal(result.valid, false);
});

test('escape: path under a dangling link is rejected', async () => {
  const result = await validateWorkspacePath(ws('dangling', 'x'));
  assert.equal(result.valid, false);
  const resolution = await realpathThroughMissingSegments(ws('dangling', 'x'));
  assert.equal(resolution.ok, false);
  assert.equal(!resolution.ok && resolution.code, 'SYMLINK_TARGET_MISSING');
});

test('escape: the dangling link itself is rejected', async () => {
  const result = await validateWorkspacePath(ws('dangling'));
  assert.equal(result.valid, false);
});

test('internal link with missing segments resolves through the link', async () => {
  const result = await validateWorkspacePath(ws('in', 'a', 'b'));
  assert.equal(result.valid, true);
  assert.equal(result.resolvedPath, path.join(fs.realpathSync(ws('real')), 'a', 'b'));
});

test('existing no-link path: resolvedPath equals realpathSync (attestation contract)', async () => {
  const existing = ws('real', 'existing');
  const result = await validateWorkspacePath(existing);
  assert.equal(result.valid, true);
  assert.equal(result.resolvedPath, fs.realpathSync(existing));
  assert.equal(result.resolvedPath, existing);
});

test('fully missing path under the root is accepted', async () => {
  const result = await validateWorkspacePath(ws('new', 'deep', 'project'));
  assert.equal(result.valid, true);
  assert.equal(result.resolvedPath, ws('new', 'deep', 'project'));
});

test('EACCES while resolving is rejected (fail-closed)', { skip: process.getuid?.() === 0 }, async () => {
  fs.chmodSync(ws('locked'), 0o000);
  try {
    const result = await validateWorkspacePath(ws('locked', 'child', 'x'));
    assert.equal(result.valid, false);
    const resolution = await realpathThroughMissingSegments(ws('locked', 'child', 'x'));
    assert.equal(!resolution.ok && resolution.code, 'RESOLUTION_FAILED');
  } finally {
    fs.chmodSync(ws('locked'), 0o755);
  }
});

test('path outside the root without links is still rejected', async () => {
  const result = await validateWorkspacePath(path.join(outsideDir, 'x'));
  assert.equal(result.valid, false);
});
