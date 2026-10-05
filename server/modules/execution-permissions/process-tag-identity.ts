/**
 * T-1910 S2: durable run tag and exact child lookup for permission-admitted provider runs.
 *
 * The tag `pe-<decisionId>` rides in the child env under the process-monitor variable, so it
 * names the decision that admitted the run and survives a server restart (unlike a random tag).
 */

import fs from 'node:fs';

import type { PermissionChildIdentity } from '@/modules/database/index.js';

import { readRuntimeProcessIdentity } from './adapter.js';

/** Env variable the process monitor already scans (session-process-monitor.js). */
export const PERMISSION_PROCESS_TAG_ENV = 'CCUI_PROCESS_TAG';

const DECISION_ID = /^[A-Za-z0-9-]{1,128}$/u;

/** Durable run tag for a decision id; null when the id is not a plain token (no tag then). */
export const permissionProcessTag = (decisionId: unknown): string | null => (
  typeof decisionId === 'string' && DECISION_ID.test(decisionId) ? `pe-${decisionId}` : null
);

type ScanDependencies = Readonly<{
  ownPid: number;
  listPids(): string[];
  readFile(file: string): Buffer;
  readIdentity(pid: number): PermissionChildIdentity | null;
}>;

const defaultDependencies: ScanDependencies = {
  ownPid: process.pid,
  listPids: () => fs.readdirSync('/proc'),
  readFile: file => fs.readFileSync(file),
  readIdentity: readRuntimeProcessIdentity,
};

/** Parent pid from /proc/<pid>/stat, or null when unreadable. */
const readParentPid = (pid: number, dependencies: ScanDependencies): number | null => {
  const stat = dependencies.readFile(`/proc/${pid}/stat`).toString('utf8');
  const close = stat.lastIndexOf(')');
  if (close === -1) return null;
  const ppid = Number(stat.slice(close + 2).split(' ')[1]);
  return Number.isSafeInteger(ppid) ? ppid : null;
};

/**
 * True when the NUL-delimited environ holds exactly `KEY=VALUE` as one entry. Never a substring
 * match; the bytes are compared in place and never retained, decoded or logged.
 */
export const environHasExactPair = (environ: Buffer, key: string, value: string): boolean => {
  const wanted = Buffer.from(`${key}=${value}`, 'utf8');
  let start = 0;
  while (start <= environ.length) {
    let end = environ.indexOf(0, start);
    if (end === -1) end = environ.length;
    if (end - start === wanted.length && environ.compare(wanted, 0, wanted.length, start, end) === 0) {
      return true;
    }
    start = end + 1;
  }
  return false;
};

/**
 * Exact identity of this server's direct child carrying `tag`, or null when it cannot be proven.
 * A pid that vanishes or is unreadable (ESRCH/ENOENT/EACCES) is uncertain and never matches;
 * more than one match, or a start-ticks change across the read, also yields null.
 */
export const findDirectChildByProcessTag = (
  tag: string,
  dependencies: ScanDependencies = defaultDependencies,
): PermissionChildIdentity | null => {
  let names: string[];
  try { names = dependencies.listPids(); } catch { return null; }
  const matches: PermissionChildIdentity[] = [];
  for (const name of names) {
    if (!/^\d+$/u.test(name)) continue;
    const pid = Number(name);
    try {
      if (readParentPid(pid, dependencies) !== dependencies.ownPid) continue;
      const before = dependencies.readIdentity(pid);
      if (!before) continue;
      if (!environHasExactPair(dependencies.readFile(`/proc/${pid}/environ`), PERMISSION_PROCESS_TAG_ENV, tag)) {
        continue;
      }
      const after = dependencies.readIdentity(pid);
      if (after && after.startTicks === before.startTicks && after.bootId === before.bootId) matches.push(after);
    } catch {
      // Uncertain (raced exit or no permission): this pid proves nothing either way.
    }
  }
  return matches.length === 1 ? matches[0] : null;
};

/**
 * Outcome of a host-wide tag scan. Only `absent` is proof. `hidden` = a process of our uid
 * whose environ is unreadable (non-dumpable agent) and that may descend from the run: it will
 * not clear while that agent lives. `uncertain` = a transient read failure.
 */
export type ServiceTagScan = 'absent' | 'present' | 'hidden' | 'uncertain';

type ServiceScanDependencies = Readonly<{
  ownPid: number;
  ownUid: number;
  listPids(): string[];
  readFile(file: string): Buffer;
}>;

const defaultServiceScanDependencies: ServiceScanDependencies = {
  ownPid: process.pid,
  ownUid: typeof process.getuid === 'function' ? process.getuid() : -1,
  listPids: () => fs.readdirSync('/proc'),
  readFile: file => fs.readFileSync(file),
};

/** Linux reports /proc start times in USER_HZ, which the kernel ABI fixes at 100. */
const USER_HZ = 100;
/** Slack for wall-clock adjustments between boot (btime) and the decision timestamp. */
const START_TIME_SLACK_MS = 60_000;

/** Real/effective/saved/fs uids from /proc/<pid>/status, or null when the line is absent. */
const readStatusUids = (status: string): number[] | null => {
  const line = status.split('\n').find(entry => entry.startsWith('Uid:'));
  if (!line) return null;
  const uids = line.slice(4).trim().split(/\s+/u).map(Number);
  return uids.length > 0 && uids.every(Number.isSafeInteger) ? uids : null;
};

/** Boot wall-clock time in ms from /proc/stat `btime`, or null when unreadable. */
const readBootTimeMs = (dependencies: ServiceScanDependencies): number | null => {
  try {
    const line = dependencies.readFile('/proc/stat').toString('utf8').split('\n')
      .find(entry => entry.startsWith('btime '));
    const seconds = Number(line?.slice(6).trim());
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch { return null; }
};

/** Wall-clock start of `pid` in ms (boot time + start ticks), or null when unprovable. */
const readStartMs = (pid: string, bootMs: number | null, dependencies: ServiceScanDependencies): number | null => {
  if (bootMs === null) return null;
  try {
    const stat = dependencies.readFile(`/proc/${pid}/stat`).toString('utf8');
    const close = stat.lastIndexOf(')');
    const ticks = close === -1 ? NaN : Number(stat.slice(close + 2).split(' ')[19]);
    return Number.isSafeInteger(ticks) && ticks >= 0 ? bootMs + (ticks * 1000) / USER_HZ : null;
  } catch { return null; }
};

const vanished = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
};

/**
 * T-1910 S4: is any process of this service's uid (not only direct children: a reparented
 * orphan counts) carrying one of `tags` as an exact env entry? Status is read for every pid,
 * so a non-dumpable process of our uid is still recognised. Its unreadable environ is
 * `uncertain` unless it provably started before `notBeforeMs` (the earliest decision being
 * proven, minus clock slack): a process older than the decision cannot descend from its run.
 * A pid that vanished mid-scan has exited and proves nothing either way.
 */
export const scanServiceProcessesForTags = (
  tags: readonly string[],
  notBeforeMs: number,
  dependencies: ServiceScanDependencies = defaultServiceScanDependencies,
): ServiceTagScan => {
  if (tags.length === 0) return 'absent';
  if (!Number.isSafeInteger(dependencies.ownUid) || dependencies.ownUid < 0
    || !Number.isSafeInteger(notBeforeMs)) return 'uncertain';
  let names: string[];
  try { names = dependencies.listPids(); } catch { return 'uncertain'; }
  const bootMs = readBootTimeMs(dependencies);
  let uncertain = false;
  let hidden = false;
  for (const name of names) {
    if (!/^\d+$/u.test(name) || Number(name) === dependencies.ownPid) continue;
    try {
      const uids = readStatusUids(dependencies.readFile(`/proc/${name}/status`).toString('utf8'));
      if (!uids) { uncertain = true; continue; }
      if (!uids.includes(dependencies.ownUid)) continue;
      let environ: Buffer;
      try { environ = dependencies.readFile(`/proc/${name}/environ`); } catch (error) {
        if (vanished(error)) continue;
        const startedMs = readStartMs(name, bootMs, dependencies);
        if (startedMs === null || startedMs >= notBeforeMs - START_TIME_SLACK_MS) hidden = true;
        continue;
      }
      if (tags.some(tag => environHasExactPair(environ, PERMISSION_PROCESS_TAG_ENV, tag))) return 'present';
    } catch (error) {
      if (!vanished(error)) uncertain = true;
    }
  }
  if (hidden) return 'hidden';
  return uncertain ? 'uncertain' : 'absent';
};
