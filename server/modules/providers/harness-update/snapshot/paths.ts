/**
 * Path layout and private-permission helpers for harness snapshots
 * (T-1871 stage 3, spec §1). Snapshot root:
 *   ~/.local/share/nassaj/harness-snapshots/<harness>/<jobId>/
 * Directories are 0700, files 0600, created under umask 077. A hard-linked
 * file is never chmod-ed (it shares the live inode).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Mode of every directory this feature creates. */
export const PRIVATE_DIR_MODE = 0o700;
/** Mode of every copied (non hard-linked) file this feature creates. */
export const PRIVATE_FILE_MODE = 0o600;
/** Infix of a file materialized for an atomic rename-into-place. */
export const RESTORE_TEMP_INFIX = '.nassaj-restore-';
/** Infix of a live file moved aside before a restore replaces it. */
export const ASIDE_INFIX = '.nassaj-pre-restore-';

const HARNESS_ID_RE = /^[a-z][a-z0-9-]{0,31}$/;
const JOB_ID_RE = /^[A-Za-z0-9][A-Za-z0-9-]{0,63}$/;

/**
 * Home under which Nassaj keeps harness snapshot state (snapshots, spawn
 * ledger, ack key). `NASSAJ_HARNESS_DATA_HOME` relocates it; the isolated test
 * runner sets it per test case so no test can reach the operator's real state.
 */
export function harnessDataHome(): string {
  return process.env.NASSAJ_HARNESS_DATA_HOME?.trim() || os.homedir();
}

/** Nassaj's private data dir (`~/.local/share/nassaj`). */
export function nassajDataDir(home: string = harnessDataHome()): string {
  return path.join(home, '.local', 'share', 'nassaj');
}

/** Root of every harness snapshot. */
export function snapshotRootDir(home: string = harnessDataHome()): string {
  return path.join(nassajDataDir(home), 'harness-snapshots');
}

/** Throws unless `value` is a safe harness id (no separators, no dots). */
export function assertHarnessId(value: string): void {
  if (!HARNESS_ID_RE.test(value)) throw new TypeError('invalid harness id');
}

/** Throws unless `value` is a safe job id (no separators, no dots). */
export function assertJobId(value: string): void {
  if (!JOB_ID_RE.test(value)) throw new TypeError('invalid job id');
}

/** `<root>/<harness>` after validating the id. */
export function harnessSnapshotDir(root: string, harness: string): string {
  assertHarnessId(harness);
  return path.join(root, harness);
}

/** `<root>/<harness>/<jobId>` after validating both ids. */
export function jobSnapshotDir(root: string, harness: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(harnessSnapshotDir(root, harness), jobId);
}

/** `<p>.nassaj-restore-<jobId>` — sibling temp used for an atomic rename. */
export function restoreTempPath(p: string, jobId: string): string {
  assertJobId(jobId);
  return `${p}${RESTORE_TEMP_INFIX}${jobId}`;
}

/** `<dir>/.<name>.nassaj-restore-<jobId>` — hidden temp for a versioned entry. */
export function versionedRestoreTempPath(dir: string, name: string, jobId: string): string {
  assertJobId(jobId);
  return path.join(dir, `.${name}${RESTORE_TEMP_INFIX}${jobId}`);
}

/** `<p>.nassaj-pre-restore-<jobId>` — where a live file is moved aside. */
export function asidePath(p: string, jobId: string): string {
  assertJobId(jobId);
  return `${p}${ASIDE_INFIX}${jobId}`;
}

/** True when `child` equals `parent` or lies beneath it (lexical, resolved). */
export function isPathInside(child: string, parent: string): boolean {
  const rel = path.relative(path.resolve(parent), path.resolve(child));
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/**
 * Runs `fn` with umask 077 and restores the previous umask. Only for
 * synchronous sections: an await inside would leak the mask to other code.
 */
export function withPrivateUmask<T>(fn: () => T): T {
  const previous = process.umask(0o077);
  try {
    return fn();
  } finally {
    process.umask(previous);
  }
}

/**
 * Creates `dir` (and parents) as 0700 and proves it is private: owned by this
 * uid, not a symlink, no group/other bits. Throws otherwise.
 */
export function ensurePrivateDir(dir: string): void {
  withPrivateUmask(() => fs.mkdirSync(dir, { recursive: true, mode: PRIVATE_DIR_MODE }));
  const st = fs.lstatSync(dir);
  if (!st.isDirectory() || st.uid !== process.getuid?.()) {
    throw new Error('snapshot directory is not a private directory');
  }
  if ((st.mode & 0o077) !== 0) fs.chmodSync(dir, PRIVATE_DIR_MODE);
}
