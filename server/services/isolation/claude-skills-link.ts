/**
 * claude-skills-link — keeps `~/.nassaj-users/<id>/.claude/skills` pointing at
 * the skills the resolver chose (ADR-203 "Switching flow", conditions 1–3).
 *
 * No pending state is stored. Each Claude launch and each provisioning pass
 * derive `desired` (private store or `~/.claude/skills`) and `actual`
 * (readlink) and reconcile:
 *   - the link is only ever replaced when lstat proves it IS a symlink and it
 *     points at one of the two known targets (shared library or this user's
 *     store); a real directory (legacy) or a foreign link is never touched;
 *   - a repoint waits while another live Claude process uses this config dir
 *     (a running session sees a repoint instantly);
 *   - repoint = symlink(tmp) + rename(tmp, link): atomic, never a window
 *     without a link. Sibling entries (e.g. `skills.bak-*`) are never read.
 * The work runs under the per-user harness-files lock; when the lock is busy the
 * current link is kept and the next launch tries again.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { tryWithHarnessFilesLockSync } from './harness-files-lock.js';
import { resolveHarnessFilesMode } from './harness-files-mode.js';
import { hasLiveClaudeSession } from './live-claude-sessions.js';
import {
  privateSkillsStoreRoot,
  seedPrivateSkillsStore,
} from './private-skills-store.js';

export type RepointStatus = 'unchanged' | 'repointed' | 'created' | 'legacy-real-dir' | 'missing-target';

export type ClaudeSkillsLinkStatus =
  | RepointStatus
  | 'in-sync'
  | 'deferred-live-session'
  | 'deferred-locked'
  | 'foreign-link'
  | 'private-store-unavailable'
  | 'not-a-user-home';

function lstatOrNull(target: string): fs.Stats | null {
  try {
    return fs.lstatSync(target);
  } catch {
    return null;
  }
}

function readlinkOrNull(link: string): string | null {
  try {
    return path.resolve(path.dirname(link), fs.readlinkSync(link));
  } catch {
    return null;
  }
}

/** The shared Claude library every user links to by default. */
export function sharedClaudeSkillsTarget(): string {
  return path.join(os.homedir(), '.claude', 'skills');
}

/** `~/.nassaj-users/<id>/.claude` for a positive integer id. */
export function userClaudeConfigDir(userId: string | number): string {
  return path.join(os.homedir(), '.nassaj-users', String(Number(userId)), '.claude');
}

/**
 * Parses the owner id out of `~/.nassaj-users/<id>/<sub>`; null for any other
 * path (operator home, anonymous spawn, unexpected layout).
 */
export function userIdFromUserHome(dir: string | null | undefined, sub: string): number | null {
  if (typeof dir !== 'string' || !dir) return null;
  const rel = path.relative(path.join(os.homedir(), '.nassaj-users'), path.resolve(dir));
  const parts = rel.split(path.sep);
  if (parts.length !== 2 || parts[1] !== sub || !/^[1-9]\d*$/.test(parts[0])) return null;
  return Number(parts[0]);
}

/**
 * Atomically points `link` at `desired`, acting only when `lstat(link)` proves a
 * symlink (or nothing is there yet). A real directory is never touched.
 */
export function repointSymlink(link: string, desired: string): RepointStatus {
  if (!lstatOrNull(desired)?.isDirectory()) return 'missing-target';
  const current = lstatOrNull(link);
  if (current && !current.isSymbolicLink()) return 'legacy-real-dir';
  if (current && readlinkOrNull(link) === path.resolve(desired)) return 'unchanged';
  const tmp = path.join(path.dirname(link), `.${path.basename(link)}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`);
  fs.symlinkSync(desired, tmp);
  try {
    fs.renameSync(tmp, link);
  } catch (err) {
    fs.rmSync(tmp, { force: true });
    throw err;
  }
  return current ? 'repointed' : 'created';
}

function desiredTarget(userId: number): { desired: string; storeRoot: string } | null {
  const storeRoot = privateSkillsStoreRoot(userId, 'claude');
  if (resolveHarnessFilesMode(userId) !== 'private') return { desired: sharedClaudeSkillsTarget(), storeRoot };
  try {
    seedPrivateSkillsStore(userId, 'claude');
  } catch (err) {
    console.warn('[harness-files] claude private store unavailable; keeping current link', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
  return { desired: storeRoot, storeRoot };
}

/**
 * Reconciles one user's Claude skills link. The caller MUST hold the user's
 * harness-files lock (use `reconcileClaudeSkillsLink` otherwise). Never throws.
 */
export function reconcileClaudeSkillsLinkLocked(userId: number): ClaudeSkillsLinkStatus {
  try {
    const target = desiredTarget(userId);
    if (!target) return 'private-store-unavailable';
    const configDir = userClaudeConfigDir(userId);
    const link = path.join(configDir, 'skills');
    const actual = lstatOrNull(link);
    if (actual && !actual.isSymbolicLink()) return 'legacy-real-dir';
    const pointsAt = actual ? readlinkOrNull(link) : null;
    if (pointsAt === path.resolve(target.desired)) return 'in-sync';
    const known = [path.resolve(sharedClaudeSkillsTarget()), path.resolve(target.storeRoot)];
    if (pointsAt !== null && !known.includes(pointsAt)) return 'foreign-link';
    if (actual && hasLiveClaudeSession(configDir)) return 'deferred-live-session';
    if (!lstatOrNull(configDir)?.isDirectory()) return 'not-a-user-home';
    return repointSymlink(link, target.desired);
  } catch (err) {
    console.warn('[harness-files] claude skills link reconcile failed (non-fatal)', {
      userId,
      error: err instanceof Error ? err.message : String(err),
    });
    return 'unchanged';
  }
}

/** Reconciles under the per-user lock; `deferred-locked` when it is busy. Never throws. */
export function reconcileClaudeSkillsLink(userId: string | number): ClaudeSkillsLinkStatus {
  const id = Number(userId);
  if (!Number.isInteger(id) || id <= 0) return 'not-a-user-home';
  const result = tryWithHarnessFilesLockSync(id, () => reconcileClaudeSkillsLinkLocked(id));
  return result.ran ? result.value : 'deferred-locked';
}

/**
 * Launch-path entry: reconciles the tree named by the spawn env's
 * CLAUDE_CONFIG_DIR (the owner's tree, also under a credential grant).
 * No-op for the operator home or a non-user path. Never throws.
 */
export function reconcileClaudeSkillsForEnv(env: NodeJS.ProcessEnv | null | undefined): ClaudeSkillsLinkStatus {
  const owner = userIdFromUserHome(env?.CLAUDE_CONFIG_DIR, '.claude');
  return owner === null ? 'not-a-user-home' : reconcileClaudeSkillsLink(owner);
}

/** Read-only link state for the settings view: does a change wait for sessions? */
export function describeClaudeSkillsLink(userId: number): 'in-sync' | 'pending' | 'legacy-real-dir' | 'absent' {
  const link = path.join(userClaudeConfigDir(userId), 'skills');
  const actual = lstatOrNull(link);
  if (!actual) return 'absent';
  if (!actual.isSymbolicLink()) return 'legacy-real-dir';
  const desired = resolveHarnessFilesMode(userId) === 'private'
    ? privateSkillsStoreRoot(userId, 'claude') : sharedClaudeSkillsTarget();
  return readlinkOrNull(link) === path.resolve(desired) ? 'in-sync' : 'pending';
}
