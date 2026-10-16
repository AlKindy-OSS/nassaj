/**
 * ADR-206 S2 (§3.2, §3.3): the memory check of the per-turn helpers switch and its lease.
 *
 * - Helpers on iff `mem% + Σ unrealised(other turns' codex-sdk leases) < 80`. The turn's own
 *   lease is not in its own check, so a lone turn at 79% gets helpers.
 * - The lease is accounting only (`3 × childMem`, childMem = 1% of host per S8 V1), never sent to Codex.
 *   It is read and inserted under BEGIN IMMEDIATE so concurrent turns see each other.
 * - `unrealised = max(0, turnReserve − peakGrowth)`; the full reserve before the first stream
 *   event; peak growth only rises, so the reserve never rises again. Every reader applies the
 *   120 s age rule at read time (resource-admission.ts `codexLeaseMemoryContribution`).
 * - No refusal path: any failure throws to the switch, which turns it into B = 0.
 * - Release proofs (H5): `dispatch_not_started` at once when the turn never reached the SDK
 *   effect seam; `process_exit` on a normal end; `process_dead` only when the S4 cleanup (or,
 *   without cleanup, the strict tag scan) proved `absent`. Otherwise the row is kept for the
 *   reclaimer, which frees it once stale, not live here, and its tag is absent.
 * - Every tag scan here has a start-time floor (the launch mark, or `created_at − 5 s` in the
 *   /proc clock). Without it, the same-uid daemons with an unreadable environ that every real
 *   host runs (systemd --user, ssh-agent, gpg-agent) make each scan `hidden`.
 * - Heartbeat is per lease: only leases in this process's live map are refreshed.
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';

import type { Database } from 'better-sqlite3';

import { getConnection } from '@/modules/database/index.js';
import type { ServiceTagScan } from '@/modules/execution-permissions/index.js';
// Leaf imports: the execution-permissions barrel would eagerly evaluate unrelated gateway
// exports, and turn-supervisor has no barrel (same seam as the S3 breaker and S4 cleanup).
// eslint-disable-next-line boundaries/dependencies
import { defaultProcScanDeps, procClockNowMs, readProcStat, scanTaggedProcesses } from '@/modules/execution-permissions/tagged-process-scan.js';
// eslint-disable-next-line boundaries/dependencies
import type { TaggedScanResult, TaggedScanTarget } from '@/modules/execution-permissions/tagged-process-scan.js';
// eslint-disable-next-line boundaries/dependencies
import * as leaseTable from '@/modules/turn-supervisor/resource-admission.js';
import { systemResourceSampler, type SystemResourceSample } from '@/services/system-resource-sampler.service.js';

export const CODEX_HELPERS_MEMORY_LIMIT = 80;
/** Codex 0.160's default child count (F4); recalibrated from V1. */
export const CODEX_CHILD_ESTIMATE = 3;
/**
 * Memory of one child as a percent of host. S8 V1 measured ~0.7% per child (3 children grew
 * the tree by ~218 MB), so 1% keeps a margin; the turn reserve is 3 × 1% = 3%.
 */
export const CODEX_CHILD_MEMORY_PERCENT = 1;
export const CODEX_TURN_RESERVE_PERCENT = CODEX_CHILD_ESTIMATE * CODEX_CHILD_MEMORY_PERCENT;
export const CODEX_LEASE_TICK_MS = 2_000;
export const CODEX_LEASE_STALE_MS = 20_000;
/** A lease's tag carriers cannot start before its row; 5 s absorbs clock and btime error. */
export const CODEX_LEASE_SCAN_FLOOR_MS = 5_000;
const MAX_SAMPLE_AGE_MS = 1_000;
const TURN_ID_PREFIX = 'codex:';

export type CodexServerIdentity = Readonly<{ bootId: string; pid: number; startTicks: string }>;

export type CodexMemoryCheckContext = Readonly<{ tag: string; userId: number | null }>;

/** How a turn ended, as far as its lease release is concerned. */
export type CodexLeaseEnd = Readonly<{
  /** The SDK effect seam (`runStreamed`) was entered: a codex process may exist. */
  started: boolean;
  /** The stream ended normally with no failure or abort (the SDK awaited the exit). */
  succeeded: boolean;
  /** The S4 cleanup result when cleanup ran, else null. */
  cleanup: Readonly<{ outcome: ServiceTagScan }> | null;
  /** Turn launch time in the /proc clock, or null when unknown (then created_at − 5 s). */
  notBeforeMs: number | null;
}>;

export type CodexLeaseFinish = 'none' | 'released' | 'retained';

export type CodexLeaseDeps = Readonly<{
  db(): Database;
  sample(): Promise<SystemResourceSample>;
  now(): number;
  leaseId(): string;
  identity(): CodexServerIdentity;
  scan(targets: readonly TaggedScanTarget[]): TaggedScanResult;
  totalMemoryKb(): number;
  /** Defaults to releaseWithExitProof. */
  release?: typeof leaseTable.releaseWithExitProof;
  /** Defaults to releaseUnstartedCodexLease. */
  releaseUnstarted?: typeof leaseTable.releaseUnstartedCodexLease;
  /** "Now" in the /proc start-time clock (tagged-process-scan procClockNowMs). */
  procClockNowMs(): number;
  startTimer(tick: () => void, everyMs: number): () => void;
  log: Readonly<{
    info(message: string, fields: Record<string, unknown>): void;
    warn(message: string, fields: Record<string, unknown>): void;
  }>;
}>;

/** `codex-sdk:<bootId>:<serverPid>:<serverStartTicks>`: distinct after any restart or pid reuse. */
export function codexLeaseOwnerId(identity: CodexServerIdentity): string {
  return `${leaseTable.CODEX_SDK_OWNER_PREFIX}${identity.bootId}:${identity.pid}:${identity.startTicks}`;
}

export const codexLeaseTurnId = (tag: string): string => `${TURN_ID_PREFIX}${tag}`;

function tagFromTurnId(turnId: string): string | null {
  return turnId.startsWith(TURN_ID_PREFIX) && turnId.length > TURN_ID_PREFIX.length
    ? turnId.slice(TURN_ID_PREFIX.length) : null;
}

/** This server's identity; throws when its start ticks cannot be read (B = 0 then). */
export function readCodexServerIdentity(read: (file: string) => Buffer = file => fs.readFileSync(file)): CodexServerIdentity {
  const { startTicks } = readProcStat(process.pid, { readFile: read });
  let bootId = 'boot-unavailable';
  try { bootId = read('/proc/sys/kernel/random/boot_id').toString('utf8').trim() || bootId; } catch { /* keep */ }
  return Object.freeze({ bootId, pid: process.pid, startTicks });
}

/** §3.2: unrealised reserve. 0 from 120 s; full before the baseline; never below 0. */
export function codexUnrealisedReserve(input: Readonly<{
  reservePercent: number;
  ageMs: number;
  baselinePercent: number | null;
  peakGrowthPercent: number;
}>): number {
  if (!(input.ageMs < leaseTable.CODEX_LEASE_MAX_AGE_MS)) return 0;
  if (input.baselinePercent === null) return input.reservePercent;
  return Math.max(0, input.reservePercent - Math.max(0, input.peakGrowthPercent));
}

/**
 * §3.3 release proof. Success → `process_exit`. Otherwise `process_dead` only when the S4
 * cleanup, or without it the strict tag scan, proved `absent`; anything else keeps the lease.
 */
export function codexLeaseExitProof(
  end: CodexLeaseEnd,
  tagOutcome: () => ServiceTagScan,
  observedAtMs: number,
): leaseTable.ProcessExitProof | null {
  if (end.succeeded) return { kind: 'process_exit', observedAtMs };
  let outcome: ServiceTagScan;
  try { outcome = end.cleanup ? end.cleanup.outcome : tagOutcome(); } catch { return null; }
  return outcome === 'absent' ? { kind: 'process_dead', observedAtMs } : null;
}

function scanOutcome(scan: TaggedScanResult, tag: string): ServiceTagScan {
  if ((scan.byTag.get(tag)?.length ?? 0) > 0) return 'present';
  if (scan.hidden) return 'hidden';
  return scan.uncertain ? 'uncertain' : 'absent';
}

type LiveLease = {
  leaseId: string;
  tag: string;
  createdAtMs: number;
  reservePercent: number;
  firstEventSeen: boolean;
  notBeforeMs: number;
  baselinePercent: number | null;
  peakGrowthPercent: number;
};

const errorText = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class CodexHelpersLeases {
  private readonly live = new Map<string, LiveLease>();
  private stopTimer: (() => void) | null = null;
  private cachedOwnerId: string | null = null;

  constructor(private readonly deps: CodexLeaseDeps) {}

  get liveCount(): number { return this.live.size; }

  private ownerId(): string {
    this.cachedOwnerId ??= codexLeaseOwnerId(this.deps.identity());
    return this.cachedOwnerId;
  }

  private async freshMemoryPercent(): Promise<number> {
    const sample = await this.deps.sample();
    const now = this.deps.now();
    const memory = sample.memoryPercent;
    if (!Number.isFinite(memory) || memory < 0 || memory > 100 || !Number.isFinite(sample.measuredAt)
      || sample.measuredAt > now || now - sample.measuredAt > MAX_SAMPLE_AGE_MS) {
      throw new Error('resource sample is invalid or stale');
    }
    return memory;
  }

  /**
   * The S2 memory check (codexHelpersRuntime.memoryOk). True: helpers on and a lease is held.
   * False: memory too high, no lease. Throws on any failure; the switch turns that into B = 0.
   */
  async reserve(ctx: CodexMemoryCheckContext): Promise<boolean> {
    if (!ctx || typeof ctx.tag !== 'string' || !ctx.tag) throw new Error('codex lease context missing');
    if (this.live.has(ctx.tag)) throw new Error('codex lease already held for this tag');
    const memoryPercent = await this.freshMemoryPercent();
    const db = this.deps.db();
    const ownerId = this.ownerId();
    const { pid } = this.deps.identity();
    const now = this.deps.now();
    const turnId = codexLeaseTurnId(ctx.tag);
    const leaseId = this.deps.leaseId();
    const userId = Number.isSafeInteger(ctx.userId) && (ctx.userId as number) > 0 ? ctx.userId as number : 0;
    this.reclaimSafely();
    const admitted = db.transaction((): boolean => {
      const others = leaseTable.sumCodexSdkLeaseMemory(db, now, turnId);
      if (!(memoryPercent + others < CODEX_HELPERS_MEMORY_LIMIT)) return false;
      db.prepare(
        `INSERT INTO turn_resource_leases (
           lease_id, turn_id, user_id, owner_id, owner_pid,
           cpu_reserved, memory_reserved, status, created_at_ms, heartbeat_at_ms
         ) VALUES (?, ?, ?, ?, ?, 0, ?, 'active', ?, ?)`,
      ).run(leaseId, turnId, userId, ownerId, pid, CODEX_TURN_RESERVE_PERCENT, now, now);
      return true;
    }).immediate();
    if (!admitted) return false;
    this.live.set(ctx.tag, {
      leaseId, tag: ctx.tag, createdAtMs: now, reservePercent: CODEX_TURN_RESERVE_PERCENT,
      firstEventSeen: false, notBeforeMs: 0, baselinePercent: null, peakGrowthPercent: 0,
    });
    this.stopTimer ??= this.deps.startTimer(() => this.tick(), CODEX_LEASE_TICK_MS);
    return true;
  }

  /** The turn's first stream event: its tree RSS now is the baseline for growth. */
  firstStreamEvent(tag: string, notBeforeMs: number): void {
    const lease = this.live.get(tag);
    if (!lease || lease.firstEventSeen) return;
    lease.firstEventSeen = true;
    lease.notBeforeMs = Number.isFinite(notBeforeMs) ? notBeforeMs : 0;
    try {
      const scan = this.deps.scan([{ tag, notBeforeMs: lease.notBeforeMs }]);
      if (!scan.uncertain) lease.baselinePercent = this.treePercent(scan, tag);
    } catch (error) {
      this.deps.log.warn('[Codex] lease baseline scan failed; full reserve kept', { reason: errorText(error) });
    }
  }

  private treePercent(scan: TaggedScanResult, tag: string): number {
    const treeKb = (scan.byTag.get(tag) ?? []).reduce((sum, proc) => sum + proc.rssKb, 0);
    const totalKb = this.deps.totalMemoryKb();
    if (!(totalKb > 0)) throw new Error('host memory total unavailable');
    return (treeKb * 100) / totalKb;
  }

  /**
   * Ends the turn's lease: stops its heartbeat and releases it with a proof when one exists.
   * Never throws; a lease without proof (or a failed release) is left to the reclaimer.
   */
  finish(tag: string, end: CodexLeaseEnd): CodexLeaseFinish {
    const lease = this.live.get(tag);
    if (!lease) return 'none';
    this.live.delete(tag);
    try {
      const now = this.deps.now();
      if (!end.started) {
        // No runStreamed: no codex process was ever spawned for this tag, so there is nothing to
        // wait for. Holding the 9% for 120 s here would let a few early launch failures add
        // phantom load to every capacity sum (and refuse runner turns with `capacity`).
        const releaseUnstarted = this.deps.releaseUnstarted ?? leaseTable.releaseUnstartedCodexLease;
        return releaseUnstarted(this.deps.db(), { leaseId: lease.leaseId, ownerId: this.ownerId(), observedAtMs: now })
          ? 'released' : 'retained';
      }
      const notBeforeMs = end.notBeforeMs ?? this.scanFloorMs(lease.createdAtMs);
      const proof = codexLeaseExitProof(end, () => this.tagOutcome(tag, notBeforeMs), now);
      if (!proof) {
        this.deps.log.info('[Codex] helpers lease kept for the reclaimer', { leaseId: lease.leaseId });
        return 'retained';
      }
      const release = this.deps.release ?? leaseTable.releaseWithExitProof;
      return release(this.deps.db(), { leaseId: lease.leaseId, ownerId: this.ownerId(), proof }) ? 'released' : 'retained';
    } catch (error) {
      this.deps.log.warn('[Codex] helpers lease release failed; reclaimer retries', {
        leaseId: lease.leaseId, reason: errorText(error),
      });
      return 'retained';
    }
  }

  /** `createdAtMs − 5 s` (wall clock) expressed in the /proc start-time clock. */
  private scanFloorMs(createdAtMs: number): number {
    const procMinusWall = this.deps.procClockNowMs() - this.deps.now();
    return createdAtMs + procMinusWall - CODEX_LEASE_SCAN_FLOOR_MS;
  }

  private tagOutcome(tag: string, notBeforeMs: number): ServiceTagScan {
    return scanOutcome(this.deps.scan([{ tag, notBeforeMs }]), tag);
  }

  /** One sampler tick: per-lease heartbeat and unrealised reserve, then reclaim. Never throws. */
  tick(): void {
    if (this.live.size === 0) {
      this.stopTimer?.();
      this.stopTimer = null;
    }
    try {
      this.refreshLive();
    } catch (error) {
      this.deps.log.warn('[Codex] helpers lease heartbeat failed', { reason: errorText(error) });
    }
    this.reclaimSafely();
  }

  private refreshLive(): void {
    if (this.live.size === 0) return;
    const now = this.deps.now();
    const measured = [...this.live.values()].filter(lease => lease.firstEventSeen && now - lease.createdAtMs < leaseTable.CODEX_LEASE_MAX_AGE_MS);
    let scan: TaggedScanResult | null = null;
    if (measured.length > 0) {
      try { scan = this.deps.scan(measured.map(lease => ({ tag: lease.tag, notBeforeMs: lease.notBeforeMs }))); } catch { scan = null; }
    }
    const db = this.deps.db();
    const update = db.prepare(
      `UPDATE turn_resource_leases SET memory_reserved = ?, heartbeat_at_ms = ?
        WHERE lease_id = ? AND owner_id = ? AND status = 'active'`,
    );
    for (const lease of [...this.live.values()]) {
      if (scan && !scan.uncertain && measured.includes(lease)) this.recordGrowth(lease, scan);
      const unrealised = codexUnrealisedReserve({
        reservePercent: lease.reservePercent,
        ageMs: now - lease.createdAtMs,
        baselinePercent: lease.baselinePercent,
        peakGrowthPercent: lease.peakGrowthPercent,
      });
      // A row released elsewhere is no longer ours to heartbeat.
      if (update.run(unrealised, now, lease.leaseId, this.ownerId()).changes === 0) this.live.delete(lease.tag);
    }
  }

  private recordGrowth(lease: LiveLease, scan: TaggedScanResult): void {
    const tree = this.treePercent(scan, lease.tag);
    if (lease.baselinePercent === null) {
      lease.baselinePercent = tree;
      return;
    }
    lease.peakGrowthPercent = Math.max(lease.peakGrowthPercent, tree - lease.baselinePercent);
  }

  /**
   * §3.3 reclaimer: a codex-sdk lease is released with `process_dead` when it is stale (no
   * heartbeat for 20 s), not live in this instance, and its tag scan is `absent`. A hidden or
   * uncertain scan proves nothing and keeps every candidate. Returns the number released.
   */
  reclaim(): number {
    const now = this.deps.now();
    const db = this.deps.db();
    const ownerId = this.ownerId();
    const liveIds = new Set([...this.live.values()].map(lease => lease.leaseId));
    const candidates = leaseTable.listActiveCodexSdkLeases(db).filter(row => (
      row.heartbeatAtMs < now - CODEX_LEASE_STALE_MS && (row.ownerId !== ownerId || !liveIds.has(row.leaseId))
    )).map(row => ({ row, tag: tagFromTurnId(row.turnId) }))
      .filter((entry): entry is { row: typeof entry.row; tag: string } => entry.tag !== null);
    if (candidates.length === 0) return 0;
    // Each tag is scanned from its row's creation − 5 s (in the /proc clock): long-lived
    // unreadable daemons started earlier cannot make the scan `hidden` for it.
    const scan = this.deps.scan(candidates.map(entry => ({ tag: entry.tag, notBeforeMs: this.scanFloorMs(entry.row.createdAtMs) })));
    const release = this.deps.release ?? leaseTable.releaseWithExitProof;
    let released = 0;
    for (const { row, tag } of candidates) {
      if (scanOutcome(scan, tag) !== 'absent') continue;
      if (release(db, { leaseId: row.leaseId, ownerId: row.ownerId, proof: { kind: 'process_dead', observedAtMs: now } })) {
        released += 1;
      }
    }
    return released;
  }

  /** Reclaim that never throws (sizing, ticks and boot call it opportunistically). */
  reclaimSafely(): number {
    try {
      return this.reclaim();
    } catch (error) {
      this.deps.log.warn('[Codex] helpers lease reclaim failed', { reason: errorText(error) });
      return 0;
    }
  }
}

function startUnrefTimer(tick: () => void, everyMs: number): () => void {
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

let serverIdentity: CodexServerIdentity | null = null;

export const defaultCodexLeaseDeps = (): CodexLeaseDeps => ({
  db: () => getConnection(),
  sample: () => systemResourceSampler.sample(),
  now: Date.now,
  leaseId: randomUUID,
  identity: () => { serverIdentity ??= readCodexServerIdentity(); return serverIdentity; },
  scan: targets => scanTaggedProcesses(targets, defaultProcScanDeps()),
  totalMemoryKb: () => os.totalmem() / 1024,
  procClockNowMs: () => procClockNowMs(),
  startTimer: startUnrefTimer,
  log: {
    info: (message, fields) => { console.log(message, fields); },
    warn: (message, fields) => { console.warn(message, fields); },
  },
});

/**
 * The process singleton the live launch path uses. Mutable on purpose (as
 * codexHelpersRuntime / codexTurnProcessRuntime): launch-path tests swap in a spy.
 */
export const codexHelpersLeaseRuntime: {
  leases: Pick<CodexHelpersLeases, 'reserve' | 'firstStreamEvent' | 'finish'>;
} = {
  leases: new CodexHelpersLeases(defaultCodexLeaseDeps()),
};

/**
 * Boot pass of the reclaimer (§3.3), run once the previous instance's rows can be stale.
 * Never throws; leaked rows hold no memory after 120 s regardless.
 */
export function scheduleCodexLeaseBootReclaim(delayMs = CODEX_LEASE_STALE_MS + CODEX_LEASE_TICK_MS): void {
  const timer = setTimeout(() => {
    const leases = codexHelpersLeaseRuntime.leases;
    if (leases instanceof CodexHelpersLeases) leases.reclaimSafely();
  }, delayMs);
  timer.unref();
}
