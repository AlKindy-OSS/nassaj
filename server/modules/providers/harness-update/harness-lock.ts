/**
 * Cross-process per-harness lock (T-1871 stage 3).
 *
 * The in-process lease (lease.ts) cannot see another Nassaj server on the same
 * host (a dev and a live server share one uid, one set of harness binaries and
 * one snapshot root). This O_EXCL lock file under the snapshot root makes a
 * snapshot job single-flight across processes, and lets boot reconcile skip a
 * manifest a LIVE sibling process is still driving. A lock whose owner process
 * is gone (pid missing, or reused with a different start time) is stale and is
 * reclaimed.
 */

import fs from 'node:fs';
import path from 'node:path';

import { ensurePrivateDir, PRIVATE_FILE_MODE, assertHarnessId } from './snapshot/paths.js';

interface LockBody {
  pid: number;
  start: string | null;
  jobId: string;
}

/** Start time token of `pid` (field 22 of /proc/<pid>/stat), or null when gone. */
export function processStartToken(pid: number, procRoot = '/proc'): string | null {
  try {
    const stat = fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8');
    return stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19] ?? null;
  } catch {
    return null;
  }
}

function lockFile(root: string, harness: string): string {
  assertHarnessId(harness);
  return path.join(root, `.${harness}.lock`);
}

function readLock(file: string): LockBody | null {
  try {
    const body = JSON.parse(fs.readFileSync(file, 'utf8')) as LockBody;
    return Number.isInteger(body?.pid) && typeof body.jobId === 'string' ? body : null;
  } catch {
    return null;
  }
}

function isAlive(body: LockBody): boolean {
  const start = processStartToken(body.pid);
  return start !== null && start === body.start;
}

function tryCreate(file: string, body: LockBody): boolean {
  try {
    const fd = fs.openSync(file, 'wx', PRIVATE_FILE_MODE);
    try {
      fs.writeFileSync(fd, JSON.stringify(body));
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
    throw error;
  }
}

/**
 * Takes the lock for `harness` on behalf of `jobId`. Returns the holder's
 * jobId on conflict with a live process, else null (acquired). A stale lock is
 * removed and the create retried once.
 */
export function acquireHarnessFileLock(root: string, harness: string, jobId: string): string | null {
  ensurePrivateDir(root);
  const file = lockFile(root, harness);
  const body: LockBody = { pid: process.pid, start: processStartToken(process.pid), jobId };
  if (tryCreate(file, body)) return null;
  const holder = readLock(file);
  if (holder && isAlive(holder)) return holder.jobId;
  fs.rmSync(file, { force: true });
  return tryCreate(file, body) ? null : readLock(file)?.jobId ?? 'unknown';
}

/** Releases the lock iff this process holds it for `jobId` (idempotent). */
export function releaseHarnessFileLock(root: string, harness: string, jobId: string): void {
  const file = lockFile(root, harness);
  const holder = readLock(file);
  if (holder && holder.pid === process.pid && holder.jobId === jobId) fs.rmSync(file, { force: true });
}

/** True when ANOTHER live process holds the lock of `harness`. */
export function isHarnessLockedElsewhere(root: string, harness: string): boolean {
  const holder = readLock(lockFile(root, harness));
  return Boolean(holder && holder.pid !== process.pid && isAlive(holder));
}

/** The updater process group a snapshot job started (persisted in its manifest). */
export interface UpdaterGroup {
  pgid: number;
  startToken: string | null;
  /** Kernel boot id when recorded; a different boot means the group is gone. */
  bootId?: string | null;
}

/** This boot's id (/proc/sys/kernel/random/boot_id), or null when unreadable. */
export function currentBootId(file = '/proc/sys/kernel/random/boot_id'): string | null {
  try {
    return fs.readFileSync(file, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Records the group of a just-spawned updater (leader pid == pgid, detached). */
export function updaterGroupOf(pid: number): UpdaterGroup {
  return { pgid: pid, startToken: processStartToken(pid), bootId: currentBootId() };
}

/**
 * True while any member of the recorded group can still run. A group recorded
 * under another kernel boot is dead (every process died with that boot). The group id is
 * not reused while members live; a live leader must carry the recorded start
 * token (else the pid was reused by an unrelated process that owns no group).
 */
export function isUpdaterGroupAlive(group: UpdaterGroup, bootId: string | null = currentBootId()): boolean {
  if (group.bootId && bootId && group.bootId !== bootId) return false;
  try {
    process.kill(-group.pgid, 0);
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
  const leader = processStartToken(group.pgid);
  return leader === null || leader === group.startToken;
}

/** SIGKILLs the recorded group (a gone group is not an error). */
export function killUpdaterGroup(group: UpdaterGroup): void {
  try {
    process.kill(-group.pgid, 'SIGKILL');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}
