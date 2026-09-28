/**
 * Open-handle scan over harness SQLite stores (T-1871 stage 3, spec §5).
 *
 * Walks `/proc/<pid>/fd/*`, readlinks each fd and matches the store paths.
 * It reports pid, `comm` and owner uid only and NEVER reads `cmdline` (a
 * foreign command line can carry secrets). Fail-closed rules:
 *   - a visible holder                                   → STORE_IN_USE
 *   - a same-uid fd dir still unreadable after 1 s retry → STORE_ACCESS_UNPROVABLE
 *   - other-uid fd dirs are unreadable by design; accepted only when every
 *     store file and dir is owned by this uid and either has no group/other
 *     bits or sits below an ancestor no other uid can traverse
 *     (assertStoresPrivate), else STORE_ACCESS_UNPROVABLE.
 * Root processes remain a documented residual risk.
 */

import fs from 'node:fs';
import path from 'node:path';

import { snapshotError } from './errors.js';

/** A process holding one of the scanned paths open. */
export interface StoreHolder {
  pid: number;
  comm: string;
  uid: number;
}

/** Scan outcome; `unreadableSameUid` lists pids, other-uid ones are counted only. */
export interface OpenHandleScan {
  holders: StoreHolder[];
  unreadableSameUid: number[];
  unreadableOtherUid: number;
}

/** Minimal /proc access, injectable for fixture trees. */
export interface ProcReader {
  listPids(): string[];
  ownerUid(pid: string): number;
  listFds(pid: string): string[];
  readFdLink(pid: string, fd: string): string;
  readComm(pid: string): string;
}

/** Options shared by the scan and the assertion. */
export interface OpenHandleOptions {
  reader?: ProcReader;
  selfUid?: number;
  sleepMs?: (ms: number) => void;
}

const DELETED_SUFFIX = ' (deleted)';
const RETRY_DELAY_MS = 1000;

/** ProcReader over a real (or fixture) proc root. Reads only `fd/*` links, `comm` and stat. */
export function procFsReader(procRoot = '/proc'): ProcReader {
  return {
    listPids: () => fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)),
    ownerUid: (pid) => fs.statSync(path.join(procRoot, pid)).uid,
    listFds: (pid) => fs.readdirSync(path.join(procRoot, pid, 'fd')),
    readFdLink: (pid, fd) => fs.readlinkSync(path.join(procRoot, pid, 'fd', fd)),
    readComm: (pid) => fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim(),
  };
}

function errCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException)?.code;
}

/** Resolved + realpath forms of every scanned path. */
function matchSet(paths: string[]): Set<string> {
  const set = new Set<string>();
  for (const p of paths) {
    set.add(path.resolve(p));
    try {
      set.add(fs.realpathSync(p));
    } catch {
      /* absent path: resolved form only */
    }
  }
  return set;
}

function pidHolds(reader: ProcReader, pid: string, targets: Set<string>): boolean {
  for (const fd of reader.listFds(pid)) {
    let link: string;
    try {
      link = reader.readFdLink(pid, fd);
    } catch (error) {
      if (errCode(error) === 'ENOENT') continue;
      throw error;
    }
    const clean = link.endsWith(DELETED_SUFFIX) ? link.slice(0, -DELETED_SUFFIX.length) : link;
    if (targets.has(clean)) return true;
  }
  return false;
}

/** Outcome for one pid: held, clear, gone, or its fd dir unreadable. */
function probePid(reader: ProcReader, pid: string, targets: Set<string>): 'held' | 'clear' | 'gone' | 'unreadable' {
  try {
    return pidHolds(reader, pid, targets) ? 'held' : 'clear';
  } catch (error) {
    const code = errCode(error);
    if (code === 'ENOENT' || code === 'ESRCH') return 'gone';
    if (code === 'EACCES' || code === 'EPERM') return 'unreadable';
    throw error;
  }
}

function ownerOrNull(reader: ProcReader, pid: string): number | null {
  try {
    return reader.ownerUid(pid);
  } catch (error) {
    if (errCode(error) === 'ENOENT' || errCode(error) === 'ESRCH') return null;
    throw error;
  }
}

/** Scans every process for an fd pointing at one of `paths` (never reads cmdline). */
export function scanOpenHandles(paths: string[], opts: OpenHandleOptions = {}): OpenHandleScan {
  const reader = opts.reader ?? procFsReader();
  const selfUid = opts.selfUid ?? process.getuid?.() ?? -1;
  const targets = matchSet(paths);
  const result: OpenHandleScan = { holders: [], unreadableSameUid: [], unreadableOtherUid: 0 };
  for (const pid of reader.listPids()) {
    const uid = ownerOrNull(reader, pid);
    if (uid === null) continue;
    const outcome = probePid(reader, pid, targets);
    if (outcome === 'held') result.holders.push({ pid: Number(pid), comm: safeComm(reader, pid), uid });
    else if (outcome === 'unreadable' && uid === selfUid) result.unreadableSameUid.push(Number(pid));
    else if (outcome === 'unreadable') result.unreadableOtherUid += 1;
  }
  return result;
}

function safeComm(reader: ProcReader, pid: string): string {
  try {
    return reader.readComm(pid);
  } catch {
    return '?';
  }
}

/** Why a store path set is not provably private. */
export type PrivacyRefusal = 'symlink' | 'foreign_owner' | 'group_or_other_access';

/** lstat that returns null for a missing path. */
function lstatExisting(p: string): fs.Stats | null {
  try {
    return fs.lstatSync(p);
  } catch (error) {
    if (errCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Walks the ancestor chain of `p` up to `/`. Every ancestor must be a real
 * directory (no symlink) owned by `selfUid` or root. Returns whether some
 * ancestor is a traversal barrier (owned by self/root, no group/other execute)
 * so no other uid can reach `p`. Above the barrier a group/other-writable dir
 * must be sticky, otherwise another uid could swap the barrier out.
 */
function ancestorChain(p: string, selfUid: number): { barrier: boolean } | { refusal: PrivacyRefusal } {
  let barrier = false;
  for (let dir = path.dirname(path.resolve(p)); ; dir = path.dirname(dir)) {
    const st = fs.lstatSync(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { refusal: 'symlink' };
    if (st.uid !== selfUid && st.uid !== 0) return { refusal: 'foreign_owner' };
    const swappable = (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0;
    if (barrier && swappable) return { refusal: 'group_or_other_access' };
    if ((st.mode & 0o011) === 0) barrier = true;
    if (dir === path.dirname(dir)) return { barrier };
  }
}

/**
 * Proves no other (non-root) uid can hold one of `paths` open. Every existing
 * path must be owned by `selfUid` and not be a symlink, and either carry no
 * group/other bits itself or sit below an ancestor barrier that other uids
 * cannot traverse (e.g. a 0700 home). The whole ancestor chain is checked for
 * symlinks and foreign owners. Nothing is ever chmod-ed. Root processes remain
 * a documented residual risk.
 */
export function assertStoresPrivate(
  paths: string[],
  selfUid: number = process.getuid?.() ?? -1,
): { ok: true } | { ok: false; reason: PrivacyRefusal } {
  for (const p of paths) {
    const st = lstatExisting(p);
    if (!st) continue;
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (st.uid !== selfUid) return { ok: false, reason: 'foreign_owner' };
    const chain = ancestorChain(p, selfUid);
    if ('refusal' in chain) return { ok: false, reason: chain.refusal };
    if ((st.mode & 0o077) !== 0 && !chain.barrier) return { ok: false, reason: 'group_or_other_access' };
  }
  return { ok: true };
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** Throws STORE_IN_USE / STORE_ACCESS_UNPROVABLE unless no process can be holding `paths`. */
export function assertNoStoreHolders(paths: string[], opts: OpenHandleOptions = {}): void {
  let scan = scanOpenHandles(paths, opts);
  if (scan.holders.length > 0) throw snapshotError('STORE_IN_USE');
  if (scan.unreadableSameUid.length > 0) {
    (opts.sleepMs ?? blockingSleep)(RETRY_DELAY_MS);
    scan = scanOpenHandles(paths, opts);
    if (scan.holders.length > 0) throw snapshotError('STORE_IN_USE');
    if (scan.unreadableSameUid.length > 0) throw snapshotError('STORE_ACCESS_UNPROVABLE');
  }
  if (scan.unreadableOtherUid > 0 && !assertStoresPrivate(paths, opts.selfUid).ok) {
    throw snapshotError('STORE_ACCESS_UNPROVABLE');
  }
}
