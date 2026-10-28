/**
 * Partial-install cleanup of the owner CLI install (ADR-215 ش4/ش5).
 *
 * Only files a vendor installer created DURING the current job are removed,
 * and only when they are listed in the descriptor's `ownedPaths`. Removal is
 * `lstat` + `unlink`: never recursive, never a directory, never a symlink
 * (except a declared launcher link whose literal target matches), never a file
 * that existed before the job, never a file owned by another uid or older than
 * the job. A hard deny-list in code refuses the credential and shell-profile
 * paths whatever a descriptor says.
 */

import fs from 'node:fs';
import path from 'node:path';

import type { OwnedPath } from './install-sources.js';

/**
 * Home-relative paths no install cleanup may ever remove (ش5): agy's
 * credential unit and its `gemini` link, Claude's data, and shell profiles.
 * Any `~/.claude*` entry (`.claude`, `.claude.json`, `.claude-*`) is denied by
 * prefix in `isDeniedCleanupPath`. Under `~/.local/share/claude` the ONLY
 * exception is a single version file `versions/<x.y.z>` (ADR-215 stage B).
 */
export const CLEANUP_DENY_LIST: readonly string[] = Object.freeze([
  '.gemini',
  path.join('.local', 'bin', 'gemini'),
  path.join('.local', 'share', 'claude'),
  '.bashrc',
  '.bash_profile',
  '.bash_login',
  '.profile',
  '.zshrc',
  '.zprofile',
  '.zshenv',
  path.join('.config', 'fish', 'config.fish'),
]);

/** The one removable path under ~/.local/share/claude: a plain x.y.z version file. */
const CLAUDE_VERSION_FILE = /^\.local\/share\/claude\/versions\/\d+\.\d+\.\d+$/u;

/** True when `target` must never be removed by install cleanup. */
export function isDeniedCleanupPath(target: string, home: string): boolean {
  if (!path.isAbsolute(target) || !path.isAbsolute(home)) return true;
  const rel = path.relative(path.resolve(home), path.resolve(target));
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return true;
  if (rel.split(path.sep)[0].startsWith('.claude')) return true;
  if (CLAUDE_VERSION_FILE.test(rel.split(path.sep).join('/'))) return false;
  return CLEANUP_DENY_LIST.some((denied) => rel === denied || rel.startsWith(`${denied}${path.sep}`));
}

/** The owned paths that exist right now (taken before the vendor step runs). */
export function existingOwnedPaths(owned: readonly OwnedPath[]): Set<string> {
  const present = new Set<string>();
  for (const entry of owned) {
    try {
      fs.lstatSync(entry.path);
      present.add(entry.path);
    } catch {
      /* absent */
    }
  }
  return present;
}

/** Outcome of one cleanup pass (audited and logged by the caller). */
export interface CleanupResult {
  removed: string[];
  /** Paths that appeared but were refused (symlink, dir, foreign, denied). */
  skipped: Array<{ path: string; reason: string }>;
}

/** `target` with its parent dir resolved (a symlinked ~/.local/bin → ~/.gemini is caught). */
function realParentPath(target: string): string {
  return path.join(fs.realpathSync(path.dirname(target)), path.basename(target));
}

function realHome(home: string): string {
  try {
    return fs.realpathSync(home);
  } catch {
    return home;
  }
}

/** Why `entry` may not be unlinked, or null when it may. */
function refusal(entry: OwnedPath, home: string, sinceMs: number): string | null {
  const st = fs.lstatSync(entry.path);
  if (isDeniedCleanupPath(entry.path, home) || isDeniedCleanupPath(realParentPath(entry.path), realHome(home))) {
    return 'denied';
  }
  if (st.isSymbolicLink()) {
    if (!entry.symlinkTo || fs.readlinkSync(entry.path) !== entry.symlinkTo) return 'symlink';
  } else if (entry.symlinkTo || !st.isFile()) {
    return 'not-a-file';
  }
  if (st.uid !== process.getuid?.()) return 'foreign-owner';
  // Appeared during this job (1 s clock slack). ctime, not mtime: tar and cp -p
  // keep the archive's mtime, but the inode change time is set at creation.
  if (st.ctimeMs < sinceMs - 1000) return 'older-than-job';
  return null;
}

/**
 * Removes the owned files that appeared since `before` was taken. With
 * `stagingOnly`, only `staging: true` entries are considered (success path).
 */
export function removeAppearedOwnedPaths(
  owned: readonly OwnedPath[],
  before: ReadonlySet<string>,
  opts: { home: string; sinceMs: number; stagingOnly: boolean },
): CleanupResult {
  const result: CleanupResult = { removed: [], skipped: [] };
  for (const entry of owned) {
    if (before.has(entry.path) || (opts.stagingOnly && !entry.staging)) continue;
    try {
      const why = refusal(entry, opts.home, opts.sinceMs);
      if (why) {
        result.skipped.push({ path: entry.path, reason: why });
        continue;
      }
      fs.unlinkSync(entry.path);
      result.removed.push(entry.path);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') result.skipped.push({ path: entry.path, reason: 'error' });
    }
  }
  return result;
}
