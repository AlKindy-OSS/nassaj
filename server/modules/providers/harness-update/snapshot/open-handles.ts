/**
 * Open-handle scan over harness SQLite stores (T-1871 stage 3, spec §5).
 *
 * Walks `/proc/<pid>/fd/*`, readlinks each fd and matches the store paths.
 * It reports pid, `comm` and owner uid only and NEVER reads `cmdline` (a
 * foreign command line can carry secrets). Fail-closed rules:
 *   - a visible holder                                   → STORE_IN_USE
 *   - a same-uid fd dir still unreadable after 1 s retry → STORE_ACCESS_UNPROVABLE,
 *     unless its `comm` is a known non-dumpable system agent
 *     (NON_DUMPABLE_SYSTEM_AGENTS); the error details name the unchecked
 *     processes as `{ uncheckedProcesses: [{ pid, comm, reason }],
 *     uncheckedProcessCount }`, the list capped at UNCHECKED_PROCESS_CAP
 *   - other-uid fd dirs are unreadable by design; accepted only when every
 *     store file and dir is owned by this uid and either has no group/other
 *     bits or sits below an ancestor no other uid can traverse
 *     (assertStoresPrivate), else STORE_ACCESS_UNPROVABLE.
 * Residual risks (documented, not provable from /proc without root):
 *   - root processes, and any process holding CAP_DAC_OVERRIDE or
 *     CAP_DAC_READ_SEARCH, which can traverse a barrier and renameat below it;
 *   - an other-uid process that obtained a cwd or directory fd inside a
 *     writable ancestor below the topmost barrier before that barrier was
 *     closed (it can still rename entries there without traversing the
 *     barrier), or reaches it through a bind mount that bypasses the barrier.
 *   The B-1468 rule (a writable dir between two barriers is unreachable)
 *   accepts these in exchange for not refusing a normal 0775 `~/.local`.
 */

import fs from 'node:fs';
import path from 'node:path';

import type {
  HarnessUncheckedProcess,
  HarnessUncheckedReason,
} from '../../../../../shared/harness-update.contract.js';

import { snapshotError } from './errors.js';

/** A process holding one of the scanned paths open. */
export interface StoreHolder {
  pid: number;
  comm: string;
  uid: number;
}

/**
 * Scan outcome. `unreadableSameUid` lists same-uid processes that could not be
 * checked (allowlisted system agents excluded); other-uid ones are counted only.
 */
export interface OpenHandleScan {
  holders: StoreHolder[];
  unreadableSameUid: HarnessUncheckedProcess[];
  unreadableOtherUid: number;
}

/** Minimal /proc access, injectable for fixture trees. */
export interface ProcReader {
  listPids(): string[];
  ownerUid(pid: string): number;
  listFds(pid: string): string[];
  readFdLink(pid: string, fd: string): string;
  readComm(pid: string): string;
  /** Field 22 (`starttime`) of `/proc/<pid>/stat`; readable for non-dumpable pids. */
  readStartTime(pid: string): string;
}

/** The lstat fields the privacy proof reads; injectable for synthetic chains. */
export type PathStat = Pick<fs.Stats, 'uid' | 'mode' | 'isSymbolicLink' | 'isDirectory'>;

/** lstat implementation (default `fs.lstatSync`); must throw ENOENT for a missing path. */
export type LstatFn = (p: string) => PathStat;

/** Options shared by the scan and the assertion. */
export interface OpenHandleOptions {
  reader?: ProcReader;
  selfUid?: number;
  sleepMs?: (ms: number) => void;
  lstat?: LstatFn;
}

const DELETED_SUFFIX = ' (deleted)';
const RETRY_DELAY_MS = 1000;

/** Most unchecked processes named in error details; the total is carried separately (L4). */
export const UNCHECKED_PROCESS_CAP = 20;

const UNCHECKED_REASONS: ReadonlySet<string> = new Set<HarnessUncheckedReason>(['fd_unreadable', 'identity_unverified']);

/**
 * Same-uid processes whose `/proc/<pid>/fd` is unreadable by design, so an
 * unreadable fd dir under one of these `comm` names does not block (B-1468):
 *   - `ssh-agent`: setgid binary and calls prctl(PR_SET_DUMPABLE, 0) itself;
 *   - `gpg-agent`: hardens itself against tracing to protect key material
 *     (measured non-dumpable on this host, B-1468);
 *   - `systemd`: the per-user `systemd --user` manager (PID 1 is root-owned,
 *     so a same-uid `systemd` is the user manager); started by root through
 *     user@.service and then dropping to the uid, so the kernel keeps it
 *     non-dumpable (its fd dir lists but every readlink is EACCES);
 *   - `(sd-pam)`: that manager's PAM helper, non-dumpable for the same reason.
 * All four are present on every normal login (all four measured on this host)
 * and none is a harness or opens harness stores in normal operation. No better readable
 * signal exists: the dumpable flag is not exposed in `stat`/`status`, and
 * `exe`, `fd`, `maps` and `environ` are all ptrace-gated the same way; the
 * scanner never reads `cmdline`. `comm` is spoofable by same-uid code; that is
 * acceptable because this guard protects store consistency against the owner's
 * own harness processes (which never rename themselves to these names), not a
 * security boundary against hostile same-uid code, which could corrupt the
 * stores directly anyway. Any other unreadable same-uid pid stays fail-closed.
 */
const NON_DUMPABLE_SYSTEM_AGENTS: ReadonlySet<string> = new Set([
  'ssh-agent',
  'gpg-agent',
  'systemd',
  '(sd-pam)',
]);

/** ProcReader over a real (or fixture) proc root. Reads only `fd/*` links, `comm` and stat. */
export function procFsReader(procRoot = '/proc'): ProcReader {
  return {
    listPids: () => fs.readdirSync(procRoot).filter((n) => /^\d+$/.test(n)),
    ownerUid: (pid) => fs.statSync(path.join(procRoot, pid)).uid,
    listFds: (pid) => fs.readdirSync(path.join(procRoot, pid, 'fd')),
    readFdLink: (pid, fd) => fs.readlinkSync(path.join(procRoot, pid, 'fd', fd)),
    readComm: (pid) => fs.readFileSync(path.join(procRoot, pid, 'comm'), 'utf8').trim(),
    readStartTime: (pid) => startTimeOf(fs.readFileSync(path.join(procRoot, pid, 'stat'), 'utf8')),
  };
}

/** `starttime` (field 22) of a stat line; fields are counted after the last `)` of comm. */
export function startTimeOf(statLine: string): string {
  const commEnd = statLine.lastIndexOf(')');
  if (commEnd < 0) throw Object.assign(new Error('stat line without comm'), { code: 'EINVAL' });
  const start = statLine.slice(commEnd + 2).trim().split(/\s+/)[19];
  if (!start) throw Object.assign(new Error('stat line without starttime'), { code: 'EINVAL' });
  return start;
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
    const startBefore = uid === selfUid ? safeStartTime(reader, pid) : null;
    const outcome = probePid(reader, pid, targets);
    if (outcome === 'held') result.holders.push({ pid: Number(pid), comm: safeComm(reader, pid), uid });
    else if (outcome === 'unreadable' && uid === selfUid) recordSameUid(result, reader, pid, startBefore);
    else if (outcome === 'unreadable') result.unreadableOtherUid += 1;
  }
  return result;
}

/**
 * Records an unreadable same-uid pid unless it is an allowlisted system agent.
 * `comm` is read between two `starttime` reads (before the probe and after
 * `comm`); only an unchanged starttime proves the probed pid and the named one
 * are the same process, so a pid reused mid-scan is never allowlisted.
 */
function recordSameUid(result: OpenHandleScan, reader: ProcReader, pid: string, startBefore: string | null): void {
  const comm = safeComm(reader, pid);
  if (!NON_DUMPABLE_SYSTEM_AGENTS.has(comm)) {
    result.unreadableSameUid.push({ pid: Number(pid), comm, reason: 'fd_unreadable' });
    return;
  }
  const sameProcess = startBefore !== null && safeStartTime(reader, pid) === startBefore;
  if (!sameProcess) result.unreadableSameUid.push({ pid: Number(pid), comm, reason: 'identity_unverified' });
}

function safeStartTime(reader: ProcReader, pid: string): string | null {
  try {
    return reader.readStartTime(pid);
  } catch {
    return null;
  }
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
function lstatExisting(p: string, lstat: LstatFn): PathStat | null {
  try {
    return lstat(p);
  } catch (error) {
    if (errCode(error) === 'ENOENT') return null;
    throw error;
  }
}

/**
 * Walks the ancestor chain of `p` up to `/`. Every ancestor must be a real
 * directory (no symlink) owned by `selfUid` or root. Returns whether some
 * ancestor is a traversal barrier (owned by self/root, no group/other execute)
 * so no other uid can reach `p`. Above the topmost barrier a group/other-
 * writable dir must be sticky, otherwise another uid could swap the barrier
 * out. A writable dir between two barriers is unreachable by other uids (the
 * higher barrier blocks traversal), so it is not refused (B-1468: a 0775
 * `~/.local` under a 0700 home).
 */
function ancestorChain(
  p: string,
  selfUid: number,
  lstat: LstatFn,
): { barrier: boolean } | { refusal: PrivacyRefusal } {
  let barrier = false;
  let exposed = false;
  for (let dir = path.dirname(path.resolve(p)); ; dir = path.dirname(dir)) {
    const st = lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return { refusal: 'symlink' };
    if (st.uid !== selfUid && st.uid !== 0) return { refusal: 'foreign_owner' };
    const swappable = (st.mode & 0o022) !== 0 && (st.mode & 0o1000) === 0;
    if ((st.mode & 0o011) === 0) {
      barrier = true;
      exposed = false;
    } else if (barrier && swappable) {
      exposed = true;
    }
    if (dir === path.dirname(dir)) return exposed ? { refusal: 'group_or_other_access' } : { barrier };
  }
}

/**
 * Proves no other (non-root) uid can hold one of `paths` open. Every existing
 * path must be owned by `selfUid` and not be a symlink, and either carry no
 * group/other bits itself or sit below an ancestor barrier that other uids
 * cannot traverse (e.g. a 0700 home). The whole ancestor chain is checked for
 * symlinks and foreign owners. Nothing is ever chmod-ed. `lstat` is injectable
 * so tests can prove a synthetic chain independent of the host's ancestors.
 * Residual risks: see the module header.
 */
export function assertStoresPrivate(
  paths: string[],
  selfUid: number = process.getuid?.() ?? -1,
  lstat: LstatFn = fs.lstatSync,
): { ok: true } | { ok: false; reason: PrivacyRefusal } {
  for (const p of paths) {
    const st = lstatExisting(p, lstat);
    if (!st) continue;
    if (st.isSymbolicLink()) return { ok: false, reason: 'symlink' };
    if (st.uid !== selfUid) return { ok: false, reason: 'foreign_owner' };
    const chain = ancestorChain(p, selfUid, lstat);
    if ('refusal' in chain) return { ok: false, reason: chain.refusal };
    if ((st.mode & 0o077) !== 0 && !chain.barrier) return { ok: false, reason: 'group_or_other_access' };
  }
  return { ok: true };
}

/** Wire form of a STORE_ACCESS_UNPROVABLE refusal's unchecked processes. */
export interface UncheckedProcessDetails {
  /** At most UNCHECKED_PROCESS_CAP entries, each `{ pid, comm, reason }`. */
  uncheckedProcesses: HarnessUncheckedProcess[];
  /** Total unchecked processes; ≥ the list length. */
  uncheckedProcessCount: number;
}

function isUncheckedEntry(p: unknown): p is Required<HarnessUncheckedProcess> {
  const e = p as Partial<HarnessUncheckedProcess> | null | undefined;
  return Number.isInteger(e?.pid) && typeof e?.comm === 'string' && UNCHECKED_REASONS.has(String(e?.reason));
}

/** Builds capped details from a full unchecked list. */
export function uncheckedDetailsFrom(list: HarnessUncheckedProcess[]): UncheckedProcessDetails {
  return { uncheckedProcesses: list.slice(0, UNCHECKED_PROCESS_CAP), uncheckedProcessCount: list.length };
}

/**
 * The unchecked processes of a STORE_ACCESS_UNPROVABLE error's details,
 * re-validated as `{ pid, comm, reason }` and capped; null for any other
 * error or shape, or when no valid entry remains.
 */
export function uncheckedDetailsOf(details: unknown): UncheckedProcessDetails | null {
  const raw = details as { uncheckedProcesses?: unknown; uncheckedProcessCount?: unknown } | null | undefined;
  if (!Array.isArray(raw?.uncheckedProcesses)) return null;
  const valid = raw.uncheckedProcesses.filter(isUncheckedEntry);
  if (valid.length === 0) return null;
  const list = valid.slice(0, UNCHECKED_PROCESS_CAP).map((p) => ({ pid: p.pid, comm: p.comm, reason: p.reason }));
  const claimed = Number.isInteger(raw.uncheckedProcessCount) ? Number(raw.uncheckedProcessCount) : 0;
  return { uncheckedProcesses: list, uncheckedProcessCount: Math.max(claimed, valid.length) };
}

function blockingSleep(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Throws STORE_IN_USE / STORE_ACCESS_UNPROVABLE unless no process can be
 * holding `paths`. A same-uid refusal carries `{ uncheckedProcesses }` details.
 */
export function assertNoStoreHolders(paths: string[], opts: OpenHandleOptions = {}): void {
  let scan = scanOpenHandles(paths, opts);
  if (scan.holders.length > 0) throw snapshotError('STORE_IN_USE');
  if (scan.unreadableSameUid.length > 0) {
    (opts.sleepMs ?? blockingSleep)(RETRY_DELAY_MS);
    scan = scanOpenHandles(paths, opts);
    if (scan.holders.length > 0) throw snapshotError('STORE_IN_USE');
    if (scan.unreadableSameUid.length > 0) {
      throw snapshotError('STORE_ACCESS_UNPROVABLE', uncheckedDetailsFrom(scan.unreadableSameUid));
    }
  }
  if (scan.unreadableOtherUid > 0 && !assertStoresPrivate(paths, opts.selfUid, opts.lstat).ok) {
    throw snapshotError('STORE_ACCESS_UNPROVABLE');
  }
}
