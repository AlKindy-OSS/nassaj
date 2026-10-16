/**
 * ADR-206 §6 (S4) candidate rule: host-wide scan for the processes of one or more runs, each
 * identified by the exact env pair `CCUI_PROCESS_TAG=<tag>`. Extends the T-1910
 * `scanServiceProcessesForTags` pattern to return the matching pids, their start ticks, comm
 * and RSS, so a caller can stop them (abort cleanup) or weigh them (memory breaker).
 *
 * A process is a candidate only when ALL hold:
 *  1. it is on this host (any parent: orphans reparented to init or a subreaper count);
 *  2. its real or effective uid is the server uid;
 *  3. its environ holds the exact pair as one NUL-delimited entry (never a substring);
 *  4. it started at or after the run's launch time minus 1 s (btime resolution);
 *  5. it is not a pm2-managed app: no `pm_id` different from the server's own, no PM2 God
 *     daemon ancestor reached before the server, and it is not the server, a server
 *     ancestor or a God daemon. Every child inherits the server's pm_id and PM2_HOME, so
 *     those values alone can never be the test.
 * An unreadable environ (non-dumpable process of our uid) is `hidden`, never killed.
 */
import fs from 'node:fs';

import { PERMISSION_PROCESS_TAG_ENV, environHasExactPair } from './process-tag-identity.js';

/** btime has 1 s resolution, so a process of the run may appear up to 1 s "early". */
export const TAGGED_START_SLACK_MS = 1_000;
/** Linux reports /proc start times in USER_HZ, which the kernel ABI fixes at 100. */
const USER_HZ = 100;
const MAX_ANCESTRY = 128;
/** PM2 titles its daemon `PM2 v<version>: God Daemon (<home>)`; comm keeps the prefix. */
const PM2_DAEMON_COMM = /^PM2 v[^:\s]*:/u;

export type TaggedProcess = Readonly<{
  pid: number;
  startTicks: string;
  comm: string;
  rssKb: number;
}>;

export type TaggedScanTarget = Readonly<{ tag: string; notBeforeMs: number }>;

export type TaggedScanResult = Readonly<{
  byTag: ReadonlyMap<string, readonly TaggedProcess[]>;
  /** A same-uid process with an unreadable environ that may belong to a run. */
  hidden: boolean;
  /** A transient read failure: the scan proves nothing about some process. */
  uncertain: boolean;
}>;

export type ProcScanDeps = Readonly<{
  ownPid: number;
  ownUid: number;
  /** The server's own pm_id, or null when it does not run under pm2. */
  ownPmId: string | null;
  /** Pids named by the PM2 pid file(s); a comm match also counts. */
  pm2DaemonPids(): readonly number[];
  listPids(): string[];
  readFile(file: string): Buffer;
}>;

const readPm2DaemonPids = (): number[] => {
  const home = process.env.PM2_HOME || (process.env.HOME ? `${process.env.HOME}/.pm2` : null);
  if (!home) return [];
  try {
    const pid = Number(fs.readFileSync(`${home}/pm2.pid`, 'utf8').trim());
    return Number.isSafeInteger(pid) && pid > 1 ? [pid] : [];
  } catch { return []; }
};

export const defaultProcScanDeps = (): ProcScanDeps => ({
  ownPid: process.pid,
  ownUid: typeof process.getuid === 'function' ? process.getuid() : -1,
  ownPmId: typeof process.env.pm_id === 'string' ? process.env.pm_id : null,
  pm2DaemonPids: readPm2DaemonPids,
  listPids: () => fs.readdirSync('/proc'),
  readFile: file => fs.readFileSync(file),
});

export const isVanishedError = (error: unknown): boolean => {
  const code = (error as NodeJS.ErrnoException | null)?.code;
  return code === 'ENOENT' || code === 'ESRCH';
};

export type ProcStat = Readonly<{ comm: string; state: string; ppid: number; startTicks: string }>;

/** Parses /proc/<pid>/stat (comm may hold spaces or ')'); throws when unreadable. */
export const readProcStat = (pid: number, deps: Pick<ProcScanDeps, 'readFile'>): ProcStat => {
  const stat = deps.readFile(`/proc/${pid}/stat`).toString('utf8');
  const open = stat.indexOf('(');
  const close = stat.lastIndexOf(')');
  if (open === -1 || close === -1) throw new Error('PROC_STAT_MALFORMED');
  const fields = stat.slice(close + 2).split(' ');
  const ppid = Number(fields[1]);
  const startTicks = fields[19];
  if (!Number.isSafeInteger(ppid) || !startTicks || !/^\d+$/u.test(startTicks)) {
    throw new Error('PROC_STAT_MALFORMED');
  }
  return { comm: stat.slice(open + 1, close), state: fields[0], ppid, startTicks };
};

/** Real/effective/saved/fs uids from a /proc status text, or null when absent. */
const statusUids = (status: string): number[] | null => {
  const line = status.split('\n').find(entry => entry.startsWith('Uid:'));
  if (!line) return null;
  const uids = line.slice(4).trim().split(/\s+/u).map(Number);
  return uids.length >= 2 && uids.every(Number.isSafeInteger) ? uids : null;
};

const statusRssKb = (status: string): number => {
  const line = status.split('\n').find(entry => entry.startsWith('VmRSS:'));
  const kb = Number(line?.slice(6).trim().split(/\s+/u)[0]);
  return Number.isSafeInteger(kb) && kb >= 0 ? kb : 0;
};

/** True when the status text shows the server uid as the real or effective uid. */
export const statusIsOwnUid = (status: string, ownUid: number): boolean | null => {
  const uids = statusUids(status);
  if (!uids) return null;
  return uids[0] === ownUid || uids[1] === ownUid;
};

/** The value of `key` in a NUL-delimited environ, or null when absent. Never logged. */
export const environValue = (environ: Buffer, key: string): string | null => {
  const prefix = Buffer.from(`${key}=`, 'utf8');
  let start = 0;
  while (start < environ.length) {
    let end = environ.indexOf(0, start);
    if (end === -1) end = environ.length;
    if (end - start >= prefix.length && environ.compare(prefix, 0, prefix.length, start, start + prefix.length) === 0) {
      return environ.subarray(start + prefix.length, end).toString('utf8');
    }
    start = end + 1;
  }
  return null;
};

const readBootMs = (deps: Pick<ProcScanDeps, 'readFile'>): number | null => {
  try {
    const line = deps.readFile('/proc/stat').toString('utf8').split('\n').find(entry => entry.startsWith('btime '));
    const seconds = Number(line?.slice(6).trim());
    return Number.isSafeInteger(seconds) && seconds > 0 ? seconds * 1000 : null;
  } catch { return null; }
};

/**
 * "Now" in the clock domain of /proc start times: btime + /proc/uptime. Process start
 * times are btime + start ticks, so comparing against this value is free of wall-clock
 * drift since boot (measured ~0.9 s on the dev host) and of btime's 1 s truncation. Falls
 * back to Date.now() when /proc is unreadable.
 */
export const procClockNowMs = (deps: Pick<ProcScanDeps, 'readFile'> = defaultProcScanDeps()): number => {
  try {
    const bootMs = readBootMs(deps);
    const uptimeS = Number(deps.readFile('/proc/uptime').toString('utf8').split(' ')[0]);
    if (bootMs !== null && Number.isFinite(uptimeS) && uptimeS > 0) return Math.floor(bootMs + uptimeS * 1000);
  } catch {
    // Fall through to the wall clock.
  }
  return Date.now();
};

type Lineage = 'server' | 'pm2' | 'other' | 'unknown';

/** Read-once view of the host used by one scan; caches stat lookups for ancestry walks. */
class HostView {
  private readonly stats = new Map<number, ProcStat | null>();
  readonly serverChain = new Set<number>();
  private readonly daemonPids: Set<number>;

  constructor(private readonly deps: ProcScanDeps) {
    let daemons: readonly number[] = [];
    try { daemons = deps.pm2DaemonPids(); } catch { daemons = []; }
    this.daemonPids = new Set(daemons);
    let cursor = deps.ownPid;
    for (let depth = 0; depth < MAX_ANCESTRY && cursor > 0; depth += 1) {
      this.serverChain.add(cursor);
      const stat = this.stat(cursor);
      if (!stat || stat.ppid === cursor) break;
      cursor = stat.ppid;
    }
  }

  stat(pid: number): ProcStat | null {
    if (!this.stats.has(pid)) {
      try { this.stats.set(pid, readProcStat(pid, this.deps)); } catch { this.stats.set(pid, null); }
    }
    return this.stats.get(pid) ?? null;
  }

  isPm2Daemon(pid: number): boolean {
    if (this.daemonPids.has(pid)) return true;
    const comm = this.stat(pid)?.comm;
    return typeof comm === 'string' && PM2_DAEMON_COMM.test(comm);
  }

  /** Who the process descends from first: the server, a PM2 daemon, or neither. */
  lineage(pid: number): Lineage {
    let cursor = this.stat(pid)?.ppid;
    for (let depth = 0; depth < MAX_ANCESTRY; depth += 1) {
      if (cursor === undefined) return 'unknown';
      if (cursor === this.deps.ownPid) return 'server';
      if (cursor <= 1) return 'other';
      if (this.isPm2Daemon(cursor)) return 'pm2';
      const next = this.stat(cursor)?.ppid;
      if (next === undefined) return 'unknown';
      cursor = next;
    }
    return 'unknown';
  }
}

type Candidate = Readonly<{ pid: number; status: string; stat: ProcStat }>;

/** Rule 5: excluded as the server, its ancestors, a God daemon, or a pm2-managed app. */
const pm2Excluded = (candidate: Candidate, environ: Buffer, view: HostView, deps: ProcScanDeps): boolean | null => {
  if (view.serverChain.has(candidate.pid) || view.isPm2Daemon(candidate.pid)) return true;
  const pmId = environValue(environ, 'pm_id');
  if (pmId !== null && pmId !== deps.ownPmId) return true;
  const lineage = view.lineage(candidate.pid);
  if (lineage === 'unknown') return null;
  return lineage === 'pm2';
};

const startMs = (stat: ProcStat, bootMs: number | null): number | null => (
  bootMs === null ? null : bootMs + (Number(stat.startTicks) * 1000) / USER_HZ
);

type Accumulator = { byTag: Map<string, TaggedProcess[]>; hidden: boolean; uncertain: boolean };

/** Applies rules 3-6 to one same-uid process whose status and stat were read. */
const classify = (
  candidate: Candidate,
  targets: readonly TaggedScanTarget[],
  ctx: Readonly<{ view: HostView; deps: ProcScanDeps; bootMs: number | null; acc: Accumulator }>,
): void => {
  const { view, deps, bootMs, acc } = ctx;
  const started = startMs(candidate.stat, bootMs);
  const mayBelong = (target: TaggedScanTarget): boolean => (
    started === null || started >= target.notBeforeMs - TAGGED_START_SLACK_MS
  );
  let environ: Buffer;
  try { environ = deps.readFile(`/proc/${candidate.pid}/environ`); } catch (error) {
    if (isVanishedError(error)) return;
    const infrastructure = view.serverChain.has(candidate.pid) || view.isPm2Daemon(candidate.pid);
    if (!infrastructure && targets.some(mayBelong)) acc.hidden = true;
    return;
  }
  const matched = targets.filter(target => environHasExactPair(environ, PERMISSION_PROCESS_TAG_ENV, target.tag));
  if (matched.length === 0) return;
  const excluded = pm2Excluded(candidate, environ, view, deps);
  if (excluded === null) { acc.uncertain = true; return; }
  if (excluded) return;
  if (started === null) { acc.uncertain = true; return; }
  for (const target of matched) {
    if (!mayBelong(target)) continue;
    const list = acc.byTag.get(target.tag) ?? [];
    list.push(Object.freeze({
      pid: candidate.pid,
      startTicks: candidate.stat.startTicks,
      comm: candidate.stat.comm,
      rssKb: statusRssKb(candidate.status),
    }));
    acc.byTag.set(target.tag, list);
  }
};

/** Reads status and stat of one pid; skips other uids and vanished pids. */
const readCandidate = (name: string, ownUid: number, view: HostView, deps: ProcScanDeps, acc: Accumulator): Candidate | null => {
  const pid = Number(name);
  let status: string;
  try { status = deps.readFile(`/proc/${pid}/status`).toString('utf8'); } catch (error) {
    if (!isVanishedError(error)) acc.uncertain = true;
    return null;
  }
  const own = statusIsOwnUid(status, ownUid);
  if (own === null) { acc.uncertain = true; return null; }
  if (!own) return null;
  const stat = view.stat(pid);
  if (!stat) return null;
  if (stat.state === 'Z') return null;
  return { pid, status, stat };
};

/**
 * One host-wide pass over /proc for every target. A zombie has exited and is never a
 * candidate. The server pid itself is skipped. Never throws.
 */
export const scanTaggedProcesses = (
  targets: readonly TaggedScanTarget[],
  deps: ProcScanDeps = defaultProcScanDeps(),
): TaggedScanResult => {
  const acc: Accumulator = { byTag: new Map(), hidden: false, uncertain: false };
  if (targets.length === 0) return acc;
  if (!Number.isSafeInteger(deps.ownUid) || deps.ownUid < 0) return { ...acc, uncertain: true };
  let names: string[];
  try { names = deps.listPids(); } catch { return { ...acc, uncertain: true }; }
  const view = new HostView(deps);
  const bootMs = readBootMs(deps);
  for (const name of names) {
    if (!/^\d+$/u.test(name) || Number(name) === deps.ownPid) continue;
    const candidate = readCandidate(name, deps.ownUid, view, deps, acc);
    if (candidate) classify(candidate, targets, { view, deps, bootMs, acc });
  }
  return acc;
};

/**
 * Re-verifies that `proc` is still the same process carrying `tag`: same pid, same start
 * ticks, still our uid, still the exact pair. Any doubt is false (defeats pid reuse).
 */
export const isSameTaggedProcess = (
  proc: Pick<TaggedProcess, 'pid' | 'startTicks'>,
  tag: string,
  deps: ProcScanDeps = defaultProcScanDeps(),
): boolean => {
  try {
    const before = readProcStat(proc.pid, deps);
    if (before.startTicks !== proc.startTicks || before.state === 'Z') return false;
    if (statusIsOwnUid(deps.readFile(`/proc/${proc.pid}/status`).toString('utf8'), deps.ownUid) !== true) return false;
    if (!environHasExactPair(deps.readFile(`/proc/${proc.pid}/environ`), PERMISSION_PROCESS_TAG_ENV, tag)) return false;
    return readProcStat(proc.pid, deps).startTicks === proc.startTicks;
  } catch { return false; }
};

/** True while the exact process (pid + start ticks) exists and is not a zombie. */
export const isProcessAlive = (
  proc: Pick<TaggedProcess, 'pid' | 'startTicks'>,
  deps: Pick<ProcScanDeps, 'readFile'> = defaultProcScanDeps(),
): boolean => {
  try {
    const stat = readProcStat(proc.pid, deps);
    return stat.startTicks === proc.startTicks && stat.state !== 'Z';
  } catch (error) {
    return !isVanishedError(error);
  }
};
