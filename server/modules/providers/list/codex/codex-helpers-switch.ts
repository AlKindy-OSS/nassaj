/**
 * ADR-206 S1 (§2.2, §3.2): the per-turn helpers switch B for a Codex SDK turn.
 *
 * B ∈ {0, 1} is decided once per turn, before launch. It is an on/off switch, never a
 * count (owner decision 2026-10-13: no Nassaj count cap). B = 0 when, in order:
 *   1. the coordination level is `direct`;
 *   2. the operator set `NASSAJ_CODEX_MULTI_AGENT=off`, or a project role is present (§4);
 *   3. the smoothed CPU cannot be measured;
 *   4. the smoothed CPU is ≥ 80% (10 s average, or loadavg[0] / ncpu while the sampler has
 *      less than 10 s of history; never a single short sample);
 *   5. the memory check fails (S2, codex-helpers-lease.ts: `mem% + Σ unrealised(other
 *      turns' codex-sdk leases) < 80`; when it passes, the turn holds an accounting lease).
 * Otherwise B = 1. **No path refuses the turn**: every failure yields B = 0.
 */
import os from 'node:os';

import { normalizeCoordinationLevel } from '../../../../../shared/coordinationDirectives.js';

import { codexHelpersLeaseRuntime, type CodexMemoryCheckContext } from './codex-helpers-lease.js';

export const CODEX_HELPERS_CPU_LIMIT = 80;

export const CODEX_HELPERS_OFF_REASONS = Object.freeze([
  'coordination_level_direct', 'disabled_by_operator', 'project_roles_present',
  'measurement_unavailable', 'host_cpu_busy', 'host_memory_high',
] as const);

export type CodexHelpersOffReason = (typeof CODEX_HELPERS_OFF_REASONS)[number];

export type SmoothedCpu = Readonly<{ percent: number; source: 'window' | 'loadavg' }>;

export type CodexHelpersDecision = Readonly<{
  helpers: boolean;
  reason: CodexHelpersOffReason | null;
  cpu: SmoothedCpu | null;
}>;

/**
 * S2 seam: true when host memory admits helpers for this turn (the turn then holds a lease).
 * Throwing means "not measurable": B = 0, never a refusal.
 */
export type CodexMemoryCheck = (context: CodexMemoryCheckContext) => boolean | Promise<boolean>;

type CpuTimes = { idle: number; total: number };

export type SmoothedCpuSamplerDeps = {
  readCpuTimes?: () => CpuTimes;
  loadavg?: () => number[];
  cpuCount?: () => number;
  now?: () => number;
  /** Starts the periodic `tick`; returns its stop function. */
  startTimer?: (tick: () => void, everyMs: number) => () => void;
};

const WINDOW_MS = 10_000;
const TICK_MS = 2_000;
const MAX_SPAN_MS = 30_000;
const IDLE_STOP_MS = 10 * 60_000;

function readHostCpuTimes(): CpuTimes {
  let idle = 0;
  let total = 0;
  for (const cpu of os.cpus()) {
    idle += cpu.times.idle;
    total += Object.values(cpu.times).reduce((sum, value) => sum + value, 0);
  }
  return { idle, total };
}

function startUnrefTimer(tick: () => void, everyMs: number): () => void {
  const timer = setInterval(tick, everyMs);
  timer.unref();
  return () => clearInterval(timer);
}

/**
 * Host CPU averaged over at least 10 s. A lazy 2 s ticker keeps cumulative CPU counters
 * for the last 30 s; it starts on the first read and stops after 10 min without one.
 */
export class SmoothedCpuSampler {
  private readonly deps: Required<SmoothedCpuSamplerDeps>;
  private readonly history: Array<CpuTimes & { at: number }> = [];
  private stopTimer: (() => void) | null = null;
  private lastReadAt = 0;

  constructor(deps: SmoothedCpuSamplerDeps = {}) {
    this.deps = {
      readCpuTimes: deps.readCpuTimes ?? readHostCpuTimes,
      loadavg: deps.loadavg ?? os.loadavg,
      cpuCount: deps.cpuCount ?? (() => os.availableParallelism()),
      now: deps.now ?? Date.now,
      startTimer: deps.startTimer ?? startUnrefTimer,
    };
  }

  /** Appends one cumulative snapshot and drops those older than the 30 s span. */
  record(): void {
    const at = this.deps.now();
    this.history.push({ ...this.deps.readCpuTimes(), at });
    while (this.history.length > 0 && at - this.history[0].at > MAX_SPAN_MS) this.history.shift();
  }

  /** The smoothed CPU percentage; throws when no valid measurement exists. */
  read(): SmoothedCpu {
    this.lastReadAt = this.deps.now();
    this.ensureTicking();
    try {
      this.record();
    } catch {
      // Counters unreadable now: the load average below may still answer.
    }
    const windowed = this.windowPercent();
    if (windowed !== null) return { percent: windowed, source: 'window' };
    const cpus = this.deps.cpuCount();
    const percent = (this.deps.loadavg()[0] / cpus) * 100;
    if (!(cpus > 0) || !Number.isFinite(percent) || percent < 0) {
      throw new Error('smoothed CPU measurement unavailable');
    }
    return { percent, source: 'loadavg' };
  }

  private windowPercent(): number | null {
    const latest = this.history.at(-1);
    if (!latest) return null;
    const base = [...this.history].reverse().find(entry => latest.at - entry.at >= WINDOW_MS);
    if (!base) return null;
    const total = latest.total - base.total;
    const idle = latest.idle - base.idle;
    if (!(total > 0) || idle < 0 || idle > total) return null;
    return ((total - idle) / total) * 100;
  }

  private ensureTicking(): void {
    if (this.stopTimer) return;
    this.stopTimer = this.deps.startTimer(() => this.tick(), TICK_MS);
  }

  private tick(): void {
    if (this.deps.now() - this.lastReadAt > IDLE_STOP_MS) {
      this.stopTimer?.();
      this.stopTimer = null;
      this.history.length = 0;
      return;
    }
    try {
      this.record();
    } catch {
      // A failed tick leaves a gap; read() falls back to the load average.
    }
  }
}

/** Process singleton shared by every Codex turn in this server. */
export const codexCpuSampler = new SmoothedCpuSampler();

/**
 * Host signals the live launch path reads. Mutable on purpose: launch-path tests pin a
 * quiet host. `memoryOk` is the S2 lease-backed check.
 */
export const codexHelpersRuntime: { cpu: () => SmoothedCpu; memoryOk: CodexMemoryCheck } = {
  cpu: () => codexCpuSampler.read(),
  memoryOk: context => codexHelpersLeaseRuntime.leases.reserve(context),
};

export type DecideCodexHelpersInput = {
  level: unknown;
  /** Resolves to a truthy hit when a project-layer role is present. */
  projectRoles: () => Promise<unknown> | unknown;
  env?: NodeJS.ProcessEnv;
  cpu?: () => SmoothedCpu;
  memoryOk?: CodexMemoryCheck;
  /** The turn the memory check (and its lease) is for. Absent → the check cannot run: B = 0. */
  memoryContext?: CodexMemoryCheckContext;
};

const off = (reason: CodexHelpersOffReason, cpu: SmoothedCpu | null = null): CodexHelpersDecision => (
  Object.freeze({ helpers: false, reason, cpu })
);

async function hasProjectRoles(scan: DecideCodexHelpersInput['projectRoles']): Promise<boolean> {
  try {
    return Boolean(await scan());
  } catch {
    return true;
  }
}

/** Decides B for one turn. Never throws and never refuses: failures give B = 0. */
export async function decideCodexHelpers(input: DecideCodexHelpersInput): Promise<CodexHelpersDecision> {
  if (normalizeCoordinationLevel(input.level) === 'direct') return off('coordination_level_direct');
  try {
    const env = input.env ?? process.env;
    if (env.NASSAJ_CODEX_MULTI_AGENT?.trim().toLowerCase() === 'off') return off('disabled_by_operator');
  } catch {
    return off('measurement_unavailable');
  }
  if (await hasProjectRoles(input.projectRoles)) return off('project_roles_present');
  let cpu: SmoothedCpu;
  try {
    cpu = (input.cpu ?? codexHelpersRuntime.cpu)();
    if (!Number.isFinite(cpu.percent) || cpu.percent < 0) return off('measurement_unavailable');
  } catch {
    return off('measurement_unavailable');
  }
  if (cpu.percent >= CODEX_HELPERS_CPU_LIMIT) return off('host_cpu_busy', cpu);
  try {
    const context = input.memoryContext ?? { tag: '', userId: null };
    if (!(await (input.memoryOk ?? codexHelpersRuntime.memoryOk)(context))) return off('host_memory_high', cpu);
  } catch {
    return off('measurement_unavailable', cpu);
  }
  return Object.freeze({ helpers: true, reason: null, cpu });
}

const REASON_TEXT: Readonly<Record<CodexHelpersOffReason, { en: string; ar: string }>> = Object.freeze({
  coordination_level_direct: { en: 'coordination level direct', ar: 'مستوى التنسيق «مباشر»' },
  disabled_by_operator: { en: 'disabled by operator', ar: 'أطفأه مشغّل الخادم' },
  project_roles_present: { en: 'project roles present', ar: 'في المشروع أدوار وكلاء خاصة به' },
  measurement_unavailable: { en: 'measurement unavailable', ar: 'تعذّر قياس موارد الخادم' },
  host_cpu_busy: { en: 'host CPU busy', ar: 'المعالج مشغول' },
  host_memory_high: { en: 'host memory high', ar: 'الذاكرة مرتفعة' },
});

/** The B = 0 notice for the model, English first (the slot is English) with Arabic. */
export function codexHelpersOffNotice(reason: CodexHelpersOffReason): string {
  const text = REASON_TEXT[reason];
  return [
    `Delegation is unavailable this turn (${text.en}). Execute the work directly; do not call spawn_agent.`,
    `التفويض غير متاح هذه الجولة؛ نفّذ العمل مباشرة (السبب: ${text.ar}).`,
  ].join('\n');
}

/** The one-line notice shown to the user in the chat stream. */
export function codexHelpersOffUserNotice(reason: CodexHelpersOffReason): string {
  return `التفويض غير متاح هذه الجولة: ${REASON_TEXT[reason].ar}`;
}

/**
 * The T-1315 per-turn slot (`developer_instructions`). B = 1: the level's own runtime
 * instructions. B = 0: the notice in place of the coordination directive, followed by
 * the level-free runtime instructions (sharing and public-page guidance stay).
 */
export function codexTurnDeveloperInstructions(
  level: unknown,
  decision: CodexHelpersDecision,
  runtimeInstructions: (level: unknown) => string,
): string {
  if (decision.helpers || !decision.reason) return runtimeInstructions(level);
  return [codexHelpersOffNotice(decision.reason), runtimeInstructions('direct')].filter(Boolean).join('\n\n');
}
