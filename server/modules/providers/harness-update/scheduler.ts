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
import { startHarnessUpdate, type UpdateServiceDeps } from './update.service.js';

interface SchedulerState {
  timer: NodeJS.Timeout | null;
  ticking: boolean;
  intervalMinutes: number;
}

const state: SchedulerState = { timer: null, ticking: false, intervalMinutes: DEFAULT_INTERVAL_MINUTES };

export interface SchedulerDeps {
  now?: () => number;
  /** Injectable skip log (defaults to a structured console line). */
  logSkip?: (entry: { provider: string; reason: string }) => void;
  updateDeps?: UpdateServiceDeps;
  /** Injectable start so tests observe which harnesses were triggered. */
  runUpdate?: (provider: string) => Promise<unknown>;
  /** Injectable settings read (defaults to the persisted app_config store). */
  getSettings?: () => { enabled: boolean; intervalMinutes: number };
  /** Injectable last-run stamp (defaults to the persisted store). */
  markRun?: (at: string) => void;
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
    // The field had NO reader before (a data-only flag that read like a gate).
    if (descriptor.autoUpdaterDisableVerified !== true) {
      logSkip({ provider: descriptor.id, reason: 'autoupdater-disable-unverified' });
      continue;
    }
    attempted.push(descriptor.id);
    try {
      await runUpdate(descriptor.id);
    } catch {
      // A conflict (already running) or transient error is fine; next tick retries.
    }
  }
  markRun(new Date(now()).toISOString());
  return attempted;
}

/** Structured skip line (no secrets, no env) — one per skipped harness per tick. */
function defaultLogSkip(entry: { provider: string; reason: string }): void {
  console.warn('[harness-autoupdate-skipped]', entry);
}

/** The guarded, non-overlapping tick used by the interval. */
async function guardedTick(deps: SchedulerDeps): Promise<void> {
  if (state.ticking) return; // never overlap
  state.ticking = true;
  try {
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
