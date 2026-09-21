/**
 * Security unit tests for the shared symlink-aware path guard (B-159 / T-845).
 *
 * Exercises the two exported helpers against a REAL temp-dir filesystem (not a
 * mocked one) so the fs.realpath canonicalization is genuinely exercised — the
 * whole point of the guard is behaviour that a lexical string check cannot have:
 *
 *   - resolveReadPathInProject(root, req)      — async, read endpoints (must exist)
 *   - isResolvedPathInsideRootReal(root, path) — sync, mutate helpers (may not exist)
 *
 * Fixtures mirror the real exploit shape: a symlink living INSIDE the project
 * tree whose target is OUTSIDE it (as could ship inside a cloned repo), plus the
 * legitimate in-tree cases that must keep working. Arrange -> Act -> Assert.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import {
  resolveReadPathInProject,
  isResolvedPathInsideRootReal,
} from './utils/path-guard.js';

// Build an isolated project root + an outside dir with a secret file, and a
// symlink inside the project pointing at the outside dir. Returns absolute paths
// plus a cleanup fn. Every path is realpath()'d so assertions are stable even
// when tmpdir itself is a symlink (e.g. /tmp -> /private/tmp).
async function makeFixture() {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'pg-outside-')));
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'pg-proj-')));

  // A legitimate file inside the project.
  await mkdir(path.join(projectRoot, 'src'), { recursive: true });
  await writeFile(path.join(projectRoot, 'src', 'app.js'), 'inside\n');

  // A secret the attacker wants to reach, living OUTSIDE the project.
  await writeFile(path.join(outside, 'secret.txt'), 'top secret\n');

  // The exploit primitive: an in-tree symlink escaping to the outside dir.
  await symlink(outside, path.join(projectRoot, 'escape'));

  // A legitimate in-tree symlink (points to a file inside the project).
  await symlink(
    path.join(projectRoot, 'src', 'app.js'),
    path.join(projectRoot, 'link-to-app.js'),
  );

  return {
    outside,
    projectRoot,
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

// ---------------------------------------------------------------------------
// resolveReadPathInProject — async read guard
// ---------------------------------------------------------------------------

test('read guard — legitimate file inside the project resolves', async () => {
  const fx = await makeFixture();
  try {
    const res = await resolveReadPathInProject(fx.projectRoot, 'src/app.js');
    assert.strictEqual(res.valid, true);
    assert.strictEqual(res.realResolved, path.join(fx.projectRoot, 'src', 'app.js'));
  } finally {
    await fx.cleanup();
  }
});

test('read guard — symlink escaping the project root is REJECTED (B-159 core)', async () => {
  const fx = await makeFixture();
  try {
    // Lexically "escape/secret.txt" is under the project root; only realpath
    // reveals it lands in the outside dir.
    const res = await resolveReadPathInProject(fx.projectRoot, 'escape/secret.txt');
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 'SYMLINK_ESCAPE',
      'escaping symlink must be caught by the realpath boundary, not treated as missing');
  } finally {
    await fx.cleanup();
  }
});

test('read guard — the symlink directory itself does not escape via realpath', async () => {
  const fx = await makeFixture();
  try {
    const res = await resolveReadPathInProject(fx.projectRoot, 'escape');
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 'SYMLINK_ESCAPE');
  } finally {
    await fx.cleanup();
  }
});

test('read guard — legitimate in-tree symlink (points inside) is ALLOWED', async () => {
  const fx = await makeFixture();
  try {
    const res = await resolveReadPathInProject(fx.projectRoot, 'link-to-app.js');
    assert.strictEqual(res.valid, true);
    // The canonical path is the real file inside the tree, not the symlink name.
    assert.strictEqual(res.realResolved, path.join(fx.projectRoot, 'src', 'app.js'));
  } finally {
    await fx.cleanup();
  }
});

test('read guard — plain ../ traversal is rejected lexically (OUTSIDE_ROOT)', async () => {
  const fx = await makeFixture();
  try {
    const res = await resolveReadPathInProject(fx.projectRoot, '../secret.txt');
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 'OUTSIDE_ROOT');
  } finally {
    await fx.cleanup();
  }
});

test('read guard — absolute path outside the root is rejected (OUTSIDE_ROOT)', async () => {
  const fx = await makeFixture();
  try {
    const res = await resolveReadPathInProject(fx.projectRoot, path.join(fx.outside, 'secret.txt'));
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 'OUTSIDE_ROOT');
  } finally {
    await fx.cleanup();
  }
});

test('read guard — non-existent file inside the root is ENOENT (not a false escape)', async () => {
  const fx = await makeFixture();
  try {
    const res = await resolveReadPathInProject(fx.projectRoot, 'src/does-not-exist.js');
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 'ENOENT');
  } finally {
    await fx.cleanup();
  }
});

// ---------------------------------------------------------------------------
// isResolvedPathInsideRootReal — sync mutate guard (target may not exist yet)
// ---------------------------------------------------------------------------

test('mutate guard — new file under a real in-tree directory is allowed', async () => {
  const fx = await makeFixture();
  try {
    // src/ exists, new.js does not yet — the deepest existing ancestor (src) is
    // inside the root, so creating new.js beneath it is safe.
    const target = path.join(fx.projectRoot, 'src', 'new.js');
    assert.strictEqual(isResolvedPathInsideRootReal(fx.projectRoot, target), true);
  } finally {
    await fx.cleanup();
  }
});

test('mutate guard — a new file directly in the project root is allowed', async () => {
  const fx = await makeFixture();
  try {
    const target = path.join(fx.projectRoot, 'brand-new.txt');
    assert.strictEqual(isResolvedPathInsideRootReal(fx.projectRoot, target), true);
  } finally {
    await fx.cleanup();
  }
});

test('mutate guard — writing THROUGH an escaping symlink dir is REJECTED (B-159 write)', async () => {
  const fx = await makeFixture();
  try {
    // escape/ -> outside dir. A would-be write to escape/pwned.txt must be
    // rejected because the deepest existing ancestor (escape) canonicalizes
    // outside the root.
    const target = path.join(fx.projectRoot, 'escape', 'pwned.txt');
    assert.strictEqual(isResolvedPathInsideRootReal(fx.projectRoot, target), false);
  } finally {
    await fx.cleanup();
  }
});

test('mutate guard — existing legit file inside the tree is allowed', async () => {
  const fx = await makeFixture();
  try {
    const target = path.join(fx.projectRoot, 'src', 'app.js');
    assert.strictEqual(isResolvedPathInsideRootReal(fx.projectRoot, target), true);
  } finally {
    await fx.cleanup();
  }
});
