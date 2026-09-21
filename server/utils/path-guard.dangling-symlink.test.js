/**
 * Security unit tests for the DANGLING-symlink hole in the mutate path guard.
 *
 * Companion to server/path-guard.test.js (which covers the LIVE symlink cases
 * of B-159). The vector closed here is different and was still open:
 *
 *   A repository can ship a symlink whose target does not exist on the victim
 *   host — git stores the link, not the target — e.g. `inbox/x.md` pointing at
 *   `~/.ssh/authorized_keys`. `fs.realpathSync` throws ENOENT on such a link
 *   exactly as it does for a name that is simply absent, so the guard's
 *   "walk up to the nearest existing ancestor" loop climbed straight past the
 *   link to the project root and returned TRUE. The subsequent
 *   writeFile/copyFile then FOLLOWED the link and CREATED the attacker's target
 *   outside the tree, with attacker-controlled content.
 *
 * Every fixture is a real temp-dir filesystem with a real dangling symlink, not
 * a mock: the whole behaviour under test lives in the difference between
 * realpath() and lstat(), which a stubbed fs would paper over.
 */

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { isResolvedPathInsideRootReal, resolveReadPathInProject } from './path-guard.js';

/**
 * Project root containing a DANGLING symlink that points outside the tree
 * (target deliberately not created), mirroring a hostile cloned repo.
 */
async function makeDanglingFixture() {
  const outside = await realpath(await mkdtemp(path.join(tmpdir(), 'pg-dangle-out-')));
  const projectRoot = await realpath(await mkdtemp(path.join(tmpdir(), 'pg-dangle-proj-')));

  await mkdir(path.join(projectRoot, 'inbox'), { recursive: true });

  // The exploit primitive: link exists, target does NOT.
  const victimTarget = path.join(outside, 'authorized_keys');
  await symlink(victimTarget, path.join(projectRoot, 'inbox', 'x.md'));

  // A dangling link that is an intermediate DIRECTORY component of a deeper path.
  await symlink(path.join(outside, 'nowhere-dir'), path.join(projectRoot, 'ghostdir'));

  // Control: an ordinary, non-existent name inside the tree (must stay allowed).
  return {
    outside,
    projectRoot,
    victimTarget,
    cleanup: async () => {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outside, { recursive: true, force: true });
    },
  };
}

test('mutate guard — dangling symlink leaf pointing outside the root is REJECTED', async () => {
  const fx = await makeDanglingFixture();
  try {
    // Sanity: the fixture really is a dangling link (exists via lstat, no realpath).
    const entry = await lstat(path.join(fx.projectRoot, 'inbox', 'x.md'));
    assert.strictEqual(entry.isSymbolicLink(), true, 'fixture must be a symlink');
    await assert.rejects(realpath(path.join(fx.projectRoot, 'inbox', 'x.md')), { code: 'ENOENT' },
      'fixture must be DANGLING (its target must not exist)');

    const target = path.join(fx.projectRoot, 'inbox', 'x.md');
    assert.strictEqual(
      isResolvedPathInsideRootReal(fx.projectRoot, target),
      false,
      'a write to a dangling symlink would CREATE the attacker-chosen target outside the tree',
    );
  } finally {
    await fx.cleanup();
  }
});

test('mutate guard — dangling symlink as an INTERMEDIATE component is REJECTED', async () => {
  const fx = await makeDanglingFixture();
  try {
    // ghostdir -> <outside>/nowhere-dir (missing). Neither the leaf nor the
    // intermediate resolves, so the walk-up must stop at the link, not sail
    // past it to the project root.
    const target = path.join(fx.projectRoot, 'ghostdir', 'payload.txt');
    assert.strictEqual(isResolvedPathInsideRootReal(fx.projectRoot, target), false);
  } finally {
    await fx.cleanup();
  }
});

test('mutate guard — dangling symlink pointing INSIDE the root is still rejected (fail-closed)', async () => {
  const fx = await makeDanglingFixture();
  try {
    // Even a link whose target would land in-tree has no verifiable identity at
    // check time; the conservative answer is refusal, and the caller falls back
    // to the ordinary create path.
    await symlink(path.join(fx.projectRoot, 'not-created-yet.txt'), path.join(fx.projectRoot, 'inner-link'));
    assert.strictEqual(
      isResolvedPathInsideRootReal(fx.projectRoot, path.join(fx.projectRoot, 'inner-link')),
      false,
    );
  } finally {
    await fx.cleanup();
  }
});

// --- Non-regression: the healthy cases the guard must keep allowing ----------

test('mutate guard — a plainly non-existent name inside the tree is STILL allowed', async () => {
  const fx = await makeDanglingFixture();
  try {
    // The whole point of the lstat probe is to separate this case from the
    // dangling-link case: nothing exists at this name, so creating it is safe.
    assert.strictEqual(
      isResolvedPathInsideRootReal(fx.projectRoot, path.join(fx.projectRoot, 'inbox', 'brand-new.md')),
      true,
    );
    assert.strictEqual(
      isResolvedPathInsideRootReal(fx.projectRoot, path.join(fx.projectRoot, 'deep', 'nested', 'new.txt')),
      true,
      'a new file under several not-yet-created dirs must remain allowed',
    );
  } finally {
    await fx.cleanup();
  }
});

test('mutate guard — an existing regular file and a LIVE in-tree symlink stay allowed', async () => {
  const fx = await makeDanglingFixture();
  try {
    await writeFile(path.join(fx.projectRoot, 'real.txt'), 'hello\n');
    await symlink(path.join(fx.projectRoot, 'real.txt'), path.join(fx.projectRoot, 'live-link.txt'));

    assert.strictEqual(
      isResolvedPathInsideRootReal(fx.projectRoot, path.join(fx.projectRoot, 'real.txt')),
      true,
    );
    assert.strictEqual(
      isResolvedPathInsideRootReal(fx.projectRoot, path.join(fx.projectRoot, 'live-link.txt')),
      true,
      'a live symlink resolving INSIDE the tree must keep working (unchanged semantics)',
    );
  } finally {
    await fx.cleanup();
  }
});

test('read guard — a dangling symlink is reported as ENOENT (reads cannot create)', async () => {
  const fx = await makeDanglingFixture();
  try {
    // Reads open an existing file, so a dangling link is genuinely "not found";
    // no hardening is needed on that side and none was added.
    const res = await resolveReadPathInProject(fx.projectRoot, 'inbox/x.md');
    assert.strictEqual(res.valid, false);
    assert.strictEqual(res.code, 'ENOENT');
  } finally {
    await fx.cleanup();
  }
});
