/**
 * ADR-206 §3.4 (S3): the 92% memory breaker for Codex SDK turns.
 *
 * - Samples every 2 s while any Codex SDK turn is registered. Memory only: CPU at or above
 *   80% logs a notice and never kills.
 * - Trigger: host memory ≥ 92% for 3 consecutive samples.
 * - Culprit: the delegating turn (helpers on, B = 1) whose process tree has the largest
 *   RSS (sum over the strict tag scan), and only when that tree is ≥ 10% of host memory.
 *   Never simply the newest turn; B = 0 turns are never targets. No culprit → log, no kill.
 * - Cooldown: after an abort, none for 30 s, and 3 fresh samples are required again.
 * - Kill = the turn's own abort (reason `codex_resource_breach`), so the turn's finally runs
 *   the §6 cleanup and maps the permission outcome (cancelled vs reconciled_unknown).
 * - `oom_score_adj = 1000` on every tagged process the sampler sees (the codex exec pid is
 *   also written at its first stream event), so the kernel OOM killer prefers a codex tree
 *   over the server. Raising it needs no privilege for the same uid.
 *
 * The sampler runs while any Codex SDK turn is registered, a superset of "any active
 * codex-sdk lease" (S2 leases exist only for B = 1 turns).
 */
import fs from 'node:fs';

import { findDirectChildByProcessTag } from '../../../execution-permissions/process-tag-identity.js';
import {
  defaultProcScanDeps,
  scanTaggedProcesses,
  type ProcScanDeps,
  type TaggedProcess,
  type TaggedScanResult,
  type TaggedScanTarget,
} from '../../../execution-permissions/tagged-process-scan.js';
import { codexCpuSampler } from './codex-helpers-switch.js';
import { CODEX_BREAKER_ABORT_REASON, cleanupCodexTurnProcesses } from './codex-turn-cleanup.js';

export const BREAKER_MEMORY_PERCENT = 92;
export const BREAKER_SAMPLES = 3;
export const BREAKER_COOLDOWN_MS = 30_000;
export const BREAKER_MIN_TREE_FRACTION = 0.10;
export const BREAKER_TICK_MS = 2_000;
const CPU_NOTICE_PERCENT = 80;
const OOM_SCORE_ADJ_MAX = 1000;

export type BreakerBreach = Readonly<{ memoryPercent: number; treeKb: number; totalKb: number }>;

export type BreakerTurnInput = Readonly<{
  tag: string;
  launchMs: number;
  /** B = 1: the only kind of turn the breaker may abort. */
  helpers: boolean;
  isAborted(): boolean;
  abort(reason: string): void;
}>;

type BreakerTurn = BreakerTurnInput & { breach: BreakerBreach | null };

export type HostMemory = Readonly<{ totalKb: number; availableKb: number }>;

export type BreakerLog = Readonly<{
  info(message: string, fields: Record<string, unknown>): void;
  warn(message: string, fields: Record<string, unknown>): void;
}>;

export type BreakerDeps = Readonly<{
  readMemory(): HostMemory | null;
  /** Smoothed CPU percent, or null when unavailable. Used for a notice only. */
  readCpuPercent(): number | null;
  scan(targets: readonly TaggedScanTarget[]): TaggedScanResult;
  setOomScoreAdj(pid: number): void;
  now(): number;
  startTimer(tick: () => void, everyMs: number): () => void;
  log: BreakerLog;
}>;

/** MemTotal and MemAvailable from /proc/meminfo, or null when unreadable. */
export function readHostMemory(read: (file: string) => string = file => fs.readFileSync(file, 'utf8')): HostMemory | null {
  try {
    const lines = read('/proc/meminfo').split('\n');
    const value = (key: string): number => Number(lines.find(line => line.startsWith(`${key}:`))?.split(/\s+/u)[1]);
    const totalKb = value('MemTotal');
    const availableKb = value('MemAvailable');
    if (!(totalKb > 0) || !(availableKb >= 0) || availableKb > totalKb) return null;
    return { totalKb, availableKb };
  } catch { return null; }
}

/** Raises a process's oom_score_adj to 1000 unless it is already there. */
export function raiseOomScoreAdj(pid: number, files: Readonly<{
  read(file: string): string;
  write(file: string, data: string): void;
}> = { read: file => fs.readFileSync(file, 'utf8'), write: (file, data) => fs.writeFileSync(file, data) }): boolean {
  if (!Number.isSafeInteger(pid) || pid <= 1 || pid === process.pid) return false;
  const file = `/proc/${pid}/oom_score_adj`;
  try {
    if (Number(files.read(file).trim()) >= OOM_SCORE_ADJ_MAX) return true;
    files.write(file, String(OOM_SCORE_ADJ_MAX));
    return true;
  } catch { return false; }
}

function startUnrefTimer(tick: () => void, everyMs: number): () => void {
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

const treeKb = (procs: readonly TaggedProcess[] | undefined): number => (
  (procs ?? []).reduce((sum, proc) => sum + proc.rssKb, 0)
);

/** The breaker target: the largest delegating tree, if it is ≥ 10% of host memory. */
export function pickBreakerCulprit<T extends Pick<BreakerTurnInput, 'tag' | 'helpers' | 'isAborted'>>(
  turns: readonly T[],
  scan: TaggedScanResult,
  totalKb: number,
): Readonly<{ turn: T; treeKb: number }> | null {
  let best: { turn: T; treeKb: number } | null = null;
  for (const turn of turns) {
    if (!turn.helpers || turn.isAborted()) continue;
    const size = treeKb(scan.byTag.get(turn.tag));
    if (!best || size > best.treeKb) best = { turn, treeKb: size };
  }
  if (!best || best.treeKb < totalKb * BREAKER_MIN_TREE_FRACTION) return null;
  return best;
}

export class CodexMemoryBreaker {
  private readonly turns = new Set<BreakerTurn>();
  private stopTimer: (() => void) | null = null;
  private consecutive = 0;
  private lastAbortAt = Number.NEGATIVE_INFINITY;
  private readonly oomRaised = new Set<string>();

  constructor(private readonly deps: BreakerDeps) {}

  /** Registers a live turn; returns its handle. Starts the sampler on the first turn. */
  register(input: BreakerTurnInput): Readonly<{ unregister(): void; breach(): BreakerBreach | null }> {
    const turn: BreakerTurn = { ...input, breach: null };
    this.turns.add(turn);
    if (!this.stopTimer) this.stopTimer = this.deps.startTimer(() => this.tick(), BREAKER_TICK_MS);
    return Object.freeze({
      unregister: () => {
        this.turns.delete(turn);
        if (this.turns.size === 0) this.stop();
      },
      breach: () => turn.breach,
    });
  }

  get activeTurns(): number { return this.turns.size; }

  /** One sample. Public for tests and for the timer; never throws. */
  tick(): void {
    if (this.turns.size === 0) { this.stop(); return; }
    try {
      const turns = [...this.turns];
      const scan = this.deps.scan(turns.map(turn => ({ tag: turn.tag, notBeforeMs: turn.launchMs })));
      this.raiseOom(scan);
      this.noticeCpu();
      this.evaluate(turns, scan);
    } catch (error) {
      this.deps.log.warn('[Codex] memory breaker sample failed', {
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stop(): void {
    this.stopTimer?.();
    this.stopTimer = null;
    this.consecutive = 0;
    this.oomRaised.clear();
  }

  private raiseOom(scan: TaggedScanResult): void {
    for (const procs of scan.byTag.values()) {
      for (const proc of procs) {
        const key = `${proc.pid}:${proc.startTicks}`;
        if (this.oomRaised.has(key)) continue;
        this.deps.setOomScoreAdj(proc.pid);
        this.oomRaised.add(key);
      }
    }
  }

  private noticeCpu(): void {
    const cpu = this.deps.readCpuPercent();
    if (cpu !== null && cpu >= CPU_NOTICE_PERCENT) {
      this.deps.log.info('[Codex] host CPU busy; the breaker never stops a turn for CPU', { cpuPercent: Math.round(cpu) });
    }
  }

  private evaluate(turns: readonly BreakerTurn[], scan: TaggedScanResult): void {
    const memory = this.deps.readMemory();
    if (!memory) { this.consecutive = 0; return; }
    const memoryPercent = ((memory.totalKb - memory.availableKb) / memory.totalKb) * 100;
    this.consecutive = memoryPercent >= BREAKER_MEMORY_PERCENT ? this.consecutive + 1 : 0;
    if (this.consecutive < BREAKER_SAMPLES) return;
    if (this.deps.now() - this.lastAbortAt < BREAKER_COOLDOWN_MS) return;
    const culprit = pickBreakerCulprit(turns, scan, memory.totalKb);
    this.consecutive = 0;
    if (!culprit) {
      this.deps.log.warn('[Codex] memory breaker: high memory but no delegating Codex tree >= 10%; no kill', {
        memoryPercent: Math.round(memoryPercent),
      });
      return;
    }
    this.lastAbortAt = this.deps.now();
    culprit.turn.breach = Object.freeze({ memoryPercent, treeKb: culprit.treeKb, totalKb: memory.totalKb });
    this.deps.log.warn('[Codex] memory breaker stops the largest delegating turn', {
      memoryPercent: Math.round(memoryPercent),
      treeKb: culprit.treeKb,
      processes: scan.byTag.get(culprit.turn.tag)?.length ?? 0,
    });
    culprit.turn.abort(CODEX_BREAKER_ABORT_REASON);
  }
}

export const defaultBreakerDeps = (
  cpuPercent: () => number | null,
  scanDeps: () => ProcScanDeps = defaultProcScanDeps,
): BreakerDeps => ({
  readMemory: () => readHostMemory(),
  readCpuPercent: cpuPercent,
  scan: targets => scanTaggedProcesses(targets, scanDeps()),
  setOomScoreAdj: pid => { raiseOomScoreAdj(pid); },
  now: Date.now,
  startTimer: startUnrefTimer,
  log: {
    info: (message, fields) => { console.log(message, fields); },
    warn: (message, fields) => { console.warn(message, fields); },
  },
});

/**
 * Writes oom_score_adj 1000 on the codex exec pid as soon as its identity resolves
 * (the server's direct child carrying the exact tag). False when it cannot be proven yet.
 */
export function protectCodexExecChild(tag: string, raise: (pid: number) => boolean = raiseOomScoreAdj): boolean {
  const child = findDirectChildByProcessTag(tag);
  return child ? raise(child.pid) : false;
}

const smoothedCpuPercent = (): number | null => {
  try { return codexCpuSampler.read().percent; } catch { return null; }
};

/**
 * Process singletons the live launch path uses. Mutable on purpose (as codexHelpersRuntime):
 * launch-path tests swap in spies so no real /proc scan or signal happens there.
 */
export const codexTurnProcessRuntime: {
  breaker: Pick<CodexMemoryBreaker, 'register'>;
  cleanup: typeof cleanupCodexTurnProcesses;
  protectExecChild: (tag: string) => boolean;
} = {
  breaker: new CodexMemoryBreaker(defaultBreakerDeps(smoothedCpuPercent)),
  cleanup: input => cleanupCodexTurnProcesses(input),
  protectExecChild: tag => protectCodexExecChild(tag),
};
