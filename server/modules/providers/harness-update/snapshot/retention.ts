/**
 * Snapshot retention, disk guard and count cap (T-1871 stage 3, spec §11, M-3).
 *
 * A job snapshot is pruned when it is terminal and either older than
 * SNAPSHOT_MAX_AGE_MS or outside the newest SNAPSHOT_MAX_SUCCESSFUL_RUNS
 * succeeded runs. Non-terminal jobs (in flight, recovering, rollback_failed,
 * a restore not yet committed/reverted) are never touched. Asides follow the
 * age rule from the restore start, wherever they live; while a job still owns
 * unexpired asides only its payload is removed and the manifest stays as the
 * record of those asides. Every deletion is reported to `audit` with harness,
 * jobId, counts and bytes only — never a path.
 */

import fs from 'node:fs';
import path from 'node:path';

import { lstatOrNull } from './durable-fs.js';
import { snapshotError } from './errors.js';
import { loadManifest, type HarnessSnapshotManifest, type ManifestState } from './manifest.js';
import { ASIDE_INFIX, harnessSnapshotDir } from './paths.js';

/** Owner default: snapshots older than 7 days are pruned. */
export const SNAPSHOT_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
/** Owner default: keep the newest 3 succeeded runs. */
export const SNAPSHOT_MAX_SUCCESSFUL_RUNS = 3;
/** Refuse a snapshot that would push the filesystem above 97 % used. */
export const DISK_USAGE_CEILING = 0.97;

const TERMINAL: ReadonlySet<ManifestState> = new Set(['succeeded', 'noop', 'rolled_back', 'abandoned']);
const PAYLOAD_DIRS = ['binary', 'stores'];

/** One audited deletion (no paths, no member ids). */
export interface RetentionAuditEvent {
  action: 'harness_snapshot_pruned' | 'harness_snapshot_aside_pruned';
  harness: string | null;
  jobId: string | null;
  count: number;
  bytes: number;
}

/** Prune inputs; `asideSweepDirs` are store dirs searched for orphan asides. */
export interface PruneOptions {
  root: string;
  harness?: string;
  now?: number;
  maxAgeMs?: number;
  maxRuns?: number;
  asideSweepDirs?: string[];
  audit?: (event: RetentionAuditEvent) => void;
}

/** Totals of one prune pass. */
export interface PruneReport {
  prunedSnapshots: number;
  prunedAsides: number;
  bytes: number;
  skippedInvalid: number;
}

type ResolvedPrune = PruneOptions & { now: number; maxAgeMs: number };

interface LoadedJob {
  harness: string;
  dir: string;
  manifest: HarnessSnapshotManifest;
}

/** Recursive byte size without following symlinks. */
export function treeBytes(p: string): number {
  const st = lstatOrNull(p);
  if (!st) return 0;
  if (!st.isDirectory()) return st.isFile() ? st.size : 0;
  return fs.readdirSync(p).reduce((sum, child) => sum + treeBytes(path.join(p, child)), 0);
}

function listDirs(dir: string): string[] {
  if (!lstatOrNull(dir)?.isDirectory()) return [];
  return fs.readdirSync(dir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name);
}

function loadJobs(root: string, harnesses: string[], report: PruneReport): LoadedJob[] {
  const jobs: LoadedJob[] = [];
  for (const harness of harnesses) {
    let harnessDir: string;
    try {
      harnessDir = harnessSnapshotDir(root, harness);
    } catch {
      report.skippedInvalid += 1;
      continue;
    }
    for (const jobId of listDirs(harnessDir)) {
      const dir = path.join(harnessDir, jobId);
      try {
        jobs.push({ harness, dir, manifest: loadManifest(dir) });
      } catch {
        report.skippedInvalid += 1;
      }
    }
  }
  return jobs;
}

function isRestoreSettled(m: HarnessSnapshotManifest): boolean {
  return !m.restore || m.restore.phase === 'committed' || m.restore.phase === 'reverted';
}

/** Jobs of one harness whose snapshot payload may go (terminal and out of window). */
function expiredSnapshots(jobs: LoadedJob[], now: number, maxAgeMs: number, maxRuns: number): Set<LoadedJob> {
  const kept = new Set(
    jobs.filter((j) => j.manifest.state === 'succeeded')
      .sort((a, b) => b.manifest.createdAt - a.manifest.createdAt)
      .slice(0, maxRuns),
  );
  return new Set(jobs.filter((j) => TERMINAL.has(j.manifest.state) && isRestoreSettled(j.manifest)
    && (now - j.manifest.createdAt > maxAgeMs || !kept.has(j))));
}

function asidePaths(m: HarnessSnapshotManifest): string[] {
  return (m.restore?.files ?? []).flatMap((op) => (op.op === 'aside' ? [op.aside] : []));
}

function asidesExpired(m: HarnessSnapshotManifest, now: number, maxAgeMs: number): boolean {
  return !m.restore || now - m.restore.startedAt > maxAgeMs;
}

function removeAll(paths: string[]): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  for (const p of paths) {
    if (!lstatOrNull(p)) continue;
    bytes += treeBytes(p);
    fs.rmSync(p, { recursive: true, force: true });
    count += 1;
  }
  return { count, bytes };
}

function pruneJob(job: LoadedJob, snapshotExpired: boolean, opts: ResolvedPrune, report: PruneReport): void {
  const { manifest: m } = job;
  const asidesGone = asidesExpired(m, opts.now, opts.maxAgeMs) && isRestoreSettled(m);
  if (asidesGone) {
    const res = removeAll(asidePaths(m));
    if (res.count > 0) {
      report.prunedAsides += res.count;
      report.bytes += res.bytes;
      opts.audit?.({ action: 'harness_snapshot_aside_pruned', harness: job.harness, jobId: m.jobId, ...res });
    }
  }
  if (!snapshotExpired) return;
  const targets = asidesGone ? [job.dir] : PAYLOAD_DIRS.map((d) => path.join(job.dir, d));
  const res = removeAll(targets);
  if (res.count === 0) return;
  report.prunedSnapshots += 1;
  report.bytes += res.bytes;
  opts.audit?.({ action: 'harness_snapshot_pruned', harness: job.harness, jobId: m.jobId, count: 1, bytes: res.bytes });
}

/** Deletes aside files in `dirs` no manifest references, older than the max age (by ctime). */
function sweepOrphanAsides(dirs: string[], referenced: Set<string>, opts: ResolvedPrune, report: PruneReport): void {
  for (const dir of dirs) {
    if (!lstatOrNull(dir)?.isDirectory()) continue;
    const stale = fs.readdirSync(dir).filter((n) => n.includes(ASIDE_INFIX)).map((n) => path.join(dir, n))
      .filter((p) => !referenced.has(p) && opts.now - (lstatOrNull(p)?.ctimeMs ?? opts.now) > opts.maxAgeMs);
    const res = removeAll(stale);
    if (res.count === 0) continue;
    report.prunedAsides += res.count;
    report.bytes += res.bytes;
    opts.audit?.({ action: 'harness_snapshot_aside_pruned', harness: null, jobId: null, ...res });
  }
}

/** One retention pass (preflight, boot, daily). Returns counts and bytes only. */
export function pruneSnapshots(options: PruneOptions): PruneReport {
  const opts = { ...options, now: options.now ?? Date.now(), maxAgeMs: options.maxAgeMs ?? SNAPSHOT_MAX_AGE_MS };
  const maxRuns = options.maxRuns ?? SNAPSHOT_MAX_SUCCESSFUL_RUNS;
  const report: PruneReport = { prunedSnapshots: 0, prunedAsides: 0, bytes: 0, skippedInvalid: 0 };
  const allJobs = loadJobs(opts.root, listDirs(opts.root), report);
  const referenced = new Set(allJobs.flatMap((j) => asidePaths(j.manifest)));
  const harnesses = options.harness ? [options.harness] : [...new Set(allJobs.map((j) => j.harness))];
  for (const harness of harnesses) {
    const jobs = allJobs.filter((j) => j.harness === harness);
    const expired = expiredSnapshots(jobs, opts.now, opts.maxAgeMs, maxRuns);
    for (const job of jobs) pruneJob(job, expired.has(job), opts, report);
  }
  sweepOrphanAsides(opts.asideSweepDirs ?? [], referenced, opts, report);
  return report;
}

/** Minimal statfs view (injectable to simulate a nearly full disk). */
export type StatfsFn = (p: string) => { blocks: number | bigint; bfree: number | bigint; bsize: number | bigint };

/**
 * INSUFFICIENT_STORAGE when (used + bytesNeeded) / size would exceed 97 %.
 * Callers pass physical bytes: 0 for same-device hard links, full size for copies.
 */
export function assertDiskHeadroom(bytesNeeded: number, dir: string, statfs: StatfsFn = fs.statfsSync): void {
  const s = statfs(dir);
  const size = Number(s.blocks) * Number(s.bsize);
  const used = (Number(s.blocks) - Number(s.bfree)) * Number(s.bsize);
  if (size <= 0 || (used + bytesNeeded) / size > DISK_USAGE_CEILING) throw snapshotError('INSUFFICIENT_STORAGE');
}

/** SNAPSHOT_COUNT_CAP when a new snapshot would exceed maxRuns + 1 payload-holding snapshots. */
export function assertSnapshotCountWithinCap(root: string, harness: string, maxRuns = SNAPSHOT_MAX_SUCCESSFUL_RUNS): void {
  const dir = harnessSnapshotDir(root, harness);
  const withPayload = listDirs(dir).filter((jobId) => PAYLOAD_DIRS.some((d) => lstatOrNull(path.join(dir, jobId, d))));
  if (withPayload.length + 1 > maxRuns + 1) throw snapshotError('SNAPSHOT_COUNT_CAP');
}
