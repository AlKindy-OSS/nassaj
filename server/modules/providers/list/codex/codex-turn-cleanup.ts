/**
 * ADR-206 §6 (S4): stop the processes a Codex SDK turn left behind, on the abort, breaker
 * and early-error paths only, and map the result to the permission outcome (§3.4).
 *
 * When: user stop and the memory breaker always clean up; an error cleans up only before
 * the turn's first completed agent reply (after it, a requested background server may be
 * the work itself). A successful turn never cleans up.
 *
 * Action: SIGTERM to every candidate of the strict scan (tagged-process-scan.ts), wait up
 * to 5 s, SIGKILL survivors. Then up to CODEX_CLEANUP_RESCAN_ROUNDS bounded rescans stop any
 * newcomer (forked while the first round ran) the same way, so a fork during SIGTERM does not
 * leave a survivor that turns a clean stop into a reconciled_unknown fence. Identity (pid + start ticks + uid + exact tag) is re-verified
 * immediately before each signal, so a reused pid is never signalled. A final scan decides
 * the outcome: only `absent` is proof that nothing of the turn survives.
 */
import { randomUUID } from 'node:crypto';

import {
  defaultProcScanDeps,
  isProcessAlive,
  isSameTaggedProcess,
  procClockNowMs,
  scanTaggedProcesses,
  type ProcScanDeps,
  type TaggedProcess,
} from '../../../execution-permissions/tagged-process-scan.js';
import type { ServiceTagScan } from '../../../execution-permissions/process-tag-identity.js';

/** Abort reason the memory breaker passes to the turn's abortController. */
export const CODEX_BREAKER_ABORT_REASON = 'codex_resource_breach';

const TERM_GRACE_MS = 5_000;
/** Grace for newcomers found by a rescan (they had no warning before). */
const NEWCOMER_GRACE_MS = 2_000;
/** Bounded rescans after the first round; a process that keeps forking ends as `present`. */
export const CODEX_CLEANUP_RESCAN_ROUNDS = 2;
const KILL_SETTLE_MS = 1_000;
const POLL_MS = 100;

export type CodexCleanupReason = 'user_abort' | 'breaker' | 'error';

export type StoppedProcess = Readonly<{ pid: number; comm: string }>;

export type CodexCleanupResult = Readonly<{
  outcome: ServiceTagScan;
  stopped: readonly StoppedProcess[];
}>;

/** The turn launch time in the /proc start-time clock domain (see procClockNowMs). */
export const codexTurnLaunchMs = (): number => procClockNowMs();

/** Fallback run tag for launches without a permission decision: never reused (§6). */
export const codexFallbackRunTag = (): string => `codex-${randomUUID()}`;

export type CodexTurnEnd = Readonly<{
  /** runStreamed was entered: a child may exist. */
  effectAttempted: boolean;
  /** The stream ended normally with no failure. */
  succeeded: boolean;
  /** The turn's abort signal fired (user stop or breaker) or the stream reported abort. */
  aborted: boolean;
  abortReason: unknown;
  /** A thrown error, turn.failed, error event or non-zero exit. */
  errored: boolean;
  /** An agent_message item.completed was seen in this turn. */
  completedReply: boolean;
}>;

/** Which cleanup (if any) a finished turn needs. Pure; never cleans up after success. */
export function decideCodexTurnCleanup(end: CodexTurnEnd): CodexCleanupReason | null {
  if (!end.effectAttempted || end.succeeded) return null;
  if (end.aborted) return end.abortReason === CODEX_BREAKER_ABORT_REASON ? 'breaker' : 'user_abort';
  if (end.errored && !end.completedReply) return 'error';
  return null;
}

export type PermissionOutcome = 'succeeded' | 'failed' | 'cancelled' | 'reconciled_unknown' | 'spawn_failed';

/**
 * §3.4 outcome mapping for a started turn: a cleanup that could not prove `absent`
 * (hidden, uncertain, or a survivor) makes the outcome unknown, so the existing T-1910
 * fence path applies; otherwise abort is `cancelled` and an error `failed`.
 */
export function mapCodexStartedOutcome(input: Readonly<{
  aborted: boolean;
  failed: boolean;
  cleanup: CodexCleanupResult | null;
}>): PermissionOutcome {
  if (input.cleanup && input.cleanup.outcome !== 'absent') return 'reconciled_unknown';
  if (input.aborted) return 'cancelled';
  return input.failed ? 'failed' : 'succeeded';
}

export type CleanupDeps = Readonly<{
  scan: ProcScanDeps;
  signal(pid: number, sig: 'SIGTERM' | 'SIGKILL'): void;
  sleep(ms: number): Promise<void>;
  now(): number;
}>;

export const defaultCleanupDeps = (): CleanupDeps => ({
  scan: defaultProcScanDeps(),
  signal: (pid, sig) => { process.kill(pid, sig); },
  sleep: ms => new Promise(resolve => { setTimeout(resolve, ms).unref?.(); }),
  now: Date.now,
});

/** Sends `sig` to every process still verified as itself; returns those signalled. */
function signalVerified(procs: readonly TaggedProcess[], tag: string, sig: 'SIGTERM' | 'SIGKILL', deps: CleanupDeps): TaggedProcess[] {
  const signalled: TaggedProcess[] = [];
  for (const proc of procs) {
    if (proc.pid <= 1 || proc.pid === deps.scan.ownPid) continue;
    if (!isSameTaggedProcess(proc, tag, deps.scan)) continue;
    try {
      deps.signal(proc.pid, sig);
      signalled.push(proc);
    } catch {
      // ESRCH: it exited between the check and the signal. EPERM: not ours after all.
    }
  }
  return signalled;
}

async function waitGone(procs: readonly TaggedProcess[], budgetMs: number, deps: CleanupDeps): Promise<TaggedProcess[]> {
  const deadline = deps.now() + budgetMs;
  let alive = procs.filter(proc => isProcessAlive(proc, deps.scan));
  while (alive.length > 0 && deps.now() < deadline) {
    await deps.sleep(POLL_MS);
    alive = alive.filter(proc => isProcessAlive(proc, deps.scan));
  }
  return alive;
}

function finalOutcome(tag: string, launchMs: number, deps: CleanupDeps): ServiceTagScan {
  const scan = scanTaggedProcesses([{ tag, notBeforeMs: launchMs }], deps.scan);
  if ((scan.byTag.get(tag)?.length ?? 0) > 0) return 'present';
  if (scan.hidden) return 'hidden';
  return scan.uncertain ? 'uncertain' : 'absent';
}

/** One TERM → grace → KILL → settle round over `procs`; returns those SIGTERMed. */
async function stopRound(procs: readonly TaggedProcess[], tag: string, graceMs: number, deps: CleanupDeps): Promise<TaggedProcess[]> {
  const termed = signalVerified(procs, tag, 'SIGTERM', deps);
  const survivors = await waitGone(termed, graceMs, deps);
  const killed = signalVerified(survivors, tag, 'SIGKILL', deps);
  await waitGone(killed, KILL_SETTLE_MS, deps);
  return termed;
}

const procKey = (proc: TaggedProcess): string => `${proc.pid}:${proc.startTicks}`;

/**
 * Stops every strict-scan candidate of `tag` (§6), then rescans a bounded number of times for
 * newcomers. Never throws; a failure to prove the end state is reported as `uncertain`,
 * never as `absent`.
 */
export async function cleanupCodexTurnProcesses(
  input: Readonly<{ tag: string; launchMs: number }>,
  deps: CleanupDeps = defaultCleanupDeps(),
): Promise<CodexCleanupResult> {
  try {
    const scanTag = (): readonly TaggedProcess[] => (
      scanTaggedProcesses([{ tag: input.tag, notBeforeMs: input.launchMs }], deps.scan).byTag.get(input.tag) ?? []
    );
    const initial = scanTag();
    const handled = new Set(initial.map(procKey));
    const termed = await stopRound(initial, input.tag, TERM_GRACE_MS, deps);
    for (let round = 0; round < CODEX_CLEANUP_RESCAN_ROUNDS; round += 1) {
      const newcomers = scanTag().filter(proc => !handled.has(procKey(proc)));
      if (newcomers.length === 0) break;
      for (const proc of newcomers) handled.add(procKey(proc));
      termed.push(...await stopRound(newcomers, input.tag, NEWCOMER_GRACE_MS, deps));
    }
    const stopped = termed.filter(proc => !isProcessAlive(proc, deps.scan))
      .map(proc => Object.freeze({ pid: proc.pid, comm: proc.comm }));
    return Object.freeze({ outcome: finalOutcome(input.tag, input.launchMs, deps), stopped });
  } catch {
    return Object.freeze({ outcome: 'uncertain', stopped: [] });
  }
}

const MAX_LISTED = 12;

/** The user-facing line naming the processes a stop or the breaker ended. */
export function codexStoppedProcessesNotice(
  reason: CodexCleanupReason,
  result: CodexCleanupResult,
  breach: Readonly<{ memoryPercent: number }> | null = null,
): string {
  const listed = result.stopped.slice(0, MAX_LISTED).map(proc => `${proc.comm} (${proc.pid})`);
  const more = result.stopped.length > MAX_LISTED ? ` +${result.stopped.length - MAX_LISTED}` : '';
  const list = listed.length > 0 ? `${listed.join('، ')}${more}` : 'لا شيء';
  const head = reason === 'breaker'
    ? `أوقف قاطع الذاكرة هذه الجولة (ذاكرة الخادم ${Math.round(breach?.memoryPercent ?? 0)}%).`
    : 'أُوقفت الجولة.';
  const tail = result.outcome === 'absent' ? '' : ' تعذّر التحقق من توقف كل العمليات.';
  return `${head} العمليات المُوقفة: ${list}.${tail}`;
}
