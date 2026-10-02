/**
 * harness auto-update scheduler (T-1749 / ADR-159 item 6 / D2).
 *
 * A single interval timer. Each NON-OVERLAPPING tick reads the owner toggle +
 * interval, and — when enabled — iterates the descriptors that are `updatable`,
 * not managed-external / no-cli, AND whose built-in auto-updater disable knob is
 * VERIFIED, calling the SAME update service the manual button calls (so the
 * lease, live-session gate, digest pin, audit and cleanSpawnEnv are all shared).
 *
 * WHY THE VERIFIED-KNOB GATE (D2). An unattended sweep only makes sense for a
 * harness whose OWN updater is provably off: otherwise the CLI can still swap
 * its bytes at launch, outside the pin check and outside the no-live-session
 * gate, and the scheduler's run becomes a second, racing updater. A harness with
 * `autoUpdaterDisableVerified !== true` therefore stays MANUAL (the owner's
 * button) and each skip is logged with its reason.
 * A harness with a live session short-circuits inside the service to
 * `skipped_live_session` and is simply retried on the next tick.
 *
 * The timer re-reads the interval every tick and re-arms itself, so an owner
 * changing `intervalMinutes` takes effect without a restart. `unref()` keeps the
 * timer from holding the event loop open.
 */

import { HARNESS_UPDATE_DESCRIPTORS } from './descriptors.js';
import {
  DEFAULT_INTERVAL_MINUTES,
  getAutoUpdateSettings,
  markSchedulerRun,
} from './autoupdate-settings.js';
import { pruneHarnessSnapshots } from './harness-retention.js';
import { resolveSnapshotRuntime } from './snapshot-runtime.js';
import { startHarnessUpdate, type UpdateServiceDeps } from './update.service.js';

/** Snapshot retention runs at most once per this period, on a scheduler tick. */
export const SNAPSHOT_PRUNE_PERIOD_MS = 24 * 60 * 60 * 1000;

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  intervalMinutes: number;
  lastPruneAt: number | null;
}

const state: SchedulerState = { timer: null, ticking: false, intervalMinutes: DEFAULT_INTERVAL_MINUTES, lastPruneAt: null };

/** One structured skip line; `detail` names the live-gate blocker kind/leg. */
export interface SkipEntry {
  provider: string;
  reason: string;
  detail?: string;
}

export interface SchedulerDeps {
  now?: () => number;
  /** Injectable skip log (defaults to a structured console line). */
  logSkip?: (entry: SkipEntry) => void;
  updateDeps?: UpdateServiceDeps;
  /** Injectable start so tests observe which harnesses were triggered. */
  runUpdate?: (provider: string) => Promise<unknown>;
  /** Injectable settings read (defaults to the persisted app_config store). */
  getSettings?: () => { enabled: boolean; intervalMinutes: number };
  /** Injectable last-run stamp (defaults to the persisted store). */
  markRun?: (at: string) => void;
  /** Injectable daily snapshot retention pass (defaults to the audited prune). */
  prune?: () => void;
}

/**
 * Runs one scheduler tick. Exported for tests and for the interval callback.
 * Never throws — a single harness failure must not abort the sweep. Returns the
 * list of harness ids it attempted.
 */
export async function runAutoUpdateTick(deps: SchedulerDeps = {}): Promise<string[]> {
  const settings = (deps.getSettings ?? getAutoUpdateSettings)();
  if (!settings.enabled) return [];

  const now = deps.now ?? Date.now;
  const markRun = deps.markRun ?? markSchedulerRun;
  const runUpdate =
    deps.runUpdate
    ?? ((provider: string) =>
      startHarnessUpdate(provider, { userId: null, trigger: 'scheduler', deps: deps.updateDeps }));

  const logSkip = deps.logSkip ?? defaultLogSkip;

  const attempted: string[] = [];
  for (const descriptor of Object.values(HARNESS_UPDATE_DESCRIPTORS)) {
    if (!descriptor.updatable || descriptor.state === 'managed-external' || descriptor.state === 'no-cli') {
      continue;
    }
    // T-1871: snapshot-backed native harnesses update only from the owner's button.
    if (descriptor.manualOnly) {
      logSkip({ provider: descriptor.id, reason: 'manual-only' });
      continue;
    }
    // The field had NO reader before (a data-only flag that read like a gate).
    if (descriptor.autoUpdaterDisableVerified !== true) {
      logSkip({ provider: descriptor.id, reason: 'autoupdater-disable-unverified' });
      continue;
    }
    attempted.push(descriptor.id);
    try {
      const skip = liveSkipReason(await runUpdate(descriptor.id));
      if (skip) logSkip({ provider: descriptor.id, ...skip });
    } catch {
      // A conflict (already running) or transient error is fine; next tick retries.
    }
  }
  markRun(new Date(now()).toISOString());
  return attempted;
}

/** Error code + blocker detail of a `skipped_live_session` job (B-1474), else null. */
export function liveSkipReason(job: unknown): { reason: string; detail?: string } | null {
  const j = job as { status?: unknown; error?: { code?: unknown }; log?: unknown } | null;
  if (j?.status !== 'skipped_live_session') return null;
  const reason = typeof j.error?.code === 'string' ? j.error.code : 'skipped_live_session';
  const last = Array.isArray(j.log) ? j.log[j.log.length - 1] : undefined;
  return typeof last === 'string' ? { reason, detail: last } : { reason };
}

/** Structured skip line (no secrets, no env) — one per skipped harness per tick. */
function defaultLogSkip(entry: SkipEntry): void {
  console.warn('[harness-autoupdate-skipped]', entry);
}

/**
 * Daily snapshot retention (spec §11) on the scheduler's own tick, whether or
 * not auto-update is enabled. Never throws.
 */
export function runDailySnapshotPrune(deps: SchedulerDeps = {}): boolean {
  const now = (deps.now ?? Date.now)();
  if (state.lastPruneAt !== null && now - state.lastPruneAt < SNAPSHOT_PRUNE_PERIOD_MS) return false;
  state.lastPruneAt = now;
  try {
    (deps.prune ?? (() => pruneHarnessSnapshots(resolveSnapshotRuntime())))();
  } catch {
    /* retention retries on the next period, at preflight and at boot */
  }
  return true;
}

/** Test hook: forget when retention last ran. */
export function _resetSchedulerPruneClock(): void {
  state.lastPruneAt = null;
}

/** The guarded, non-overlapping tick used by the interval. */
async function guardedTick(deps: SchedulerDeps): Promise<void> {
  if (state.ticking) return; // never overlap
  state.ticking = true;
  try {
    runDailySnapshotPrune(deps);
    await runAutoUpdateTick(deps);
  } catch {
    /* runAutoUpdateTick already swallows per-harness errors */
  } finally {
    state.ticking = false;
  }
}

/**
 * Starts (or restarts) the scheduler timer at the currently configured interval.
 * Idempotent: a second call clears the prior timer first. Does NOT fire a tick
 * immediately (avoids an update storm at boot).
 */
export function startHarnessAutoUpdateScheduler(deps: SchedulerDeps = {}): void {
  stopHarnessAutoUpdateScheduler();
  const readSettings = deps.getSettings ?? getAutoUpdateSettings;
  const settings = readSettings();
  state.intervalMinutes = settings.intervalMinutes;
  const periodMs = settings.intervalMinutes * 60_000;
  state.timer = setInterval(() => {
    // Re-read interval each tick; re-arm if the owner changed it.
    const current = readSettings();
    void guardedTick(deps);
    if (current.intervalMinutes !== state.intervalMinutes) {
      startHarnessAutoUpdateScheduler(deps);
    }
  }, periodMs);
  state.timer.unref?.();
}

/** Stops the scheduler timer (idempotent). */
export function stopHarnessAutoUpdateScheduler(): void {
  if (state.timer) {
    clearInterval(state.timer);
    state.timer = null;
  }
}

/** Test/diagnostic: whether the timer is armed. */
export function isSchedulerRunning(): boolean {
  return state.timer !== null;
}
