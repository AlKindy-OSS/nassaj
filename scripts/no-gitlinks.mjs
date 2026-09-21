#!/usr/bin/env node
/**
 * G1 (ADR-156): submodules are excluded from this repository by architecture,
 * permanently. A gitlink entered a release once (`plugins/starter`, 1.47.0.9)
 * and broke activation *and* rollback together, because `assertUnchangedGitlinks`
 * then sat inside the direction both paths shared; the node stayed 503 until the
 * maintenance journal was hand-edited. Since 1.47.0.10 (WI-11) the preparation
 * gate refuses a gitlink change before any write (`gitlink_change_unsupported`),
 * so rollback no longer meets that check — this gate keeps gitlinks out of the
 * source in the first place.
 *
 * The live layer is therefore `npm run test:scripts` through
 * `no-gitlinks.test.mjs`, run locally before the push: under ADR-150 releases are
 * built and published locally, so that command — not a workflow — is what a
 * release actually passes through. `verify-release-main.mjs` carries the same
 * assertion for the GitHub Actions path, which the approved route does not use;
 * it is defence for a path that may return, never the gate being relied on.
 *
 * البوابة G1 دائمة (ADR-156): لا روابط فرعية في هذا المستودع. حذف gitlink داخل
 * إصدار 1.47.0.9 أسقط التفعيل والتراجع معاً وترك العقدة 503. الطبقة الحيّة تحت
 * ADR-150 هي `npm run test:scripts` وحدها قبل الدفع؛ وفحص
 * `verify-release-main.mjs` طبقة Actions غير مستعملة في المسار المعتمد.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, lstatSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const GITLINK_MODE = '160000';
const GITMODULES = '.gitmodules';

function git(root, args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 32 * 1024 * 1024,
  });
}

/** Index paths staged with the gitlink mode, read from `git ls-files -s`. */
export function stagedGitlinks(root) {
  return git(root, ['ls-files', '-s', '-z'])
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      const [attributes, relative] = entry.split('\t');
      return { mode: attributes.split(' ')[0], relative };
    })
    .filter((entry) => entry.mode === GITLINK_MODE && entry.relative)
    .map((entry) => entry.relative);
}

/**
 * Every reason this tree violates G1: a staged gitlink, a tracked `.gitmodules`
 * (whatever its blob), or a `.gitmodules` file present in the worktree at all.
 * The file was deleted with 1.47.0.10; its reappearance — tracked, untracked or
 * with a changed fingerprint — is the signal that a submodule is being added.
 */
export function gitlinkViolations(root = process.cwd()) {
  const violations = stagedGitlinks(root).map((relative) => `staged gitlink: ${relative}`);
  const tracked = git(root, ['ls-files', '-s', '-z', '--', GITMODULES]).split('\0').filter(Boolean);
  if (tracked.length > 0) violations.push(`${GITMODULES} is tracked: ${tracked[0].split('\t')[0]}`);
  const file = path.join(root, GITMODULES);
  if (existsSync(file)) violations.push(`${GITMODULES} exists in the worktree (${lstatSync(file).size} bytes)`);
  return violations;
}

/** Fail closed before any release step that would carry a gitlink onto a node. */
export function assertNoGitlinks(root = process.cwd()) {
  const violations = gitlinkViolations(root);
  if (violations.length > 0) {
    throw new Error(`submodules are excluded by ADR-156 G1 — ${violations.join('; ')}`);
  }
  return { ok: true, root };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    process.stdout.write(`${JSON.stringify(assertNoGitlinks(path.resolve(process.argv[2] || process.cwd())))}\n`);
  } catch (error) {
    process.stderr.write(`no-gitlinks: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 2;
  }
}
