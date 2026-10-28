/**
 * B-1699 (qa veto C2/M1/M3): the bounds of a scheduled wake-up hold — how long the
 * input stream of a run may stay open only because the CLI owes it a wake-up.
 *
 * Every value is provisional (coordinator decision 2026-10-27) and env-tunable:
 *   CLAUDE_SDK_SCHEDULED_WAKEUP_HOLD=0             kill switch: never hold for a wake-up
 *   CLAUDE_SDK_SCHEDULED_WAKEUP_MARGIN_MS          wait past a one-shot's time (60 s)
 *   CLAUDE_SDK_SCHEDULED_WAKEUP_TOTAL_MAX_MS       total hold from the FIRST schedule (6 h)
 *   CLAUDE_SDK_SCHEDULED_WAKEUP_MAX_PULSES         wake-up turns per run (48)
 *   CLAUDE_SDK_SCHEDULED_WAKEUP_LISTENER_GRACE_MS  no viewer at all for this long (30 min)
 *   CLAUDE_SDK_SCHEDULED_WAKEUP_LISTENER_POLL_MS   how often listeners are checked (60 s)
 * Unlike the per-result idle cap, the total cap never re-anchors, so a `/loop` cannot
 * keep a CLI process alive for ever.
 */

/** Close reason → the `noticeReason` the client translates (chatNotice.wakeupClosed.*). */
export const WAKEUP_HOLD_CLOSE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  'scheduled-wakeup-expired': 'expired',
  'scheduled-wakeup-cap': 'cap',
  'scheduled-wakeup-total-cap': 'total_cap',
  'drain-scheduled-wakeup': 'drain',
  'scheduled-wakeup-listeners-gone': 'listeners_gone',
  'scheduled-wakeup-quota': 'quota',
  'scheduled-wakeup-disabled': 'disabled',
});

/** `noticeCode` of the line sent when a wake-up hold closes. */
export const WAKEUP_HOLD_CLOSED_NOTICE_CODE = 'scheduled_wakeup_closed';

/** Usage (percent of a window) at or above which a hold is not renewed. */
export const WAKEUP_HOLD_QUOTA_LIMIT_PERCENT = 90;

export type WakeupHoldConfig = {
  enabled: boolean;
  marginMs: number;
  totalMaxMs: number;
  maxPulses: number;
  listenerGraceMs: number;
  listenerPollMs: number;
};

const positiveInt = (raw: string | undefined, fallback: number): number => {
  const value = Number.parseInt(String(raw ?? ''), 10);
  return Number.isInteger(value) && value > 0 ? value : fallback;
};

/** The hold bounds from `env`, read per run so tests and operators can tune them. */
export function readWakeupHoldConfig(env: NodeJS.ProcessEnv = process.env): WakeupHoldConfig {
  return {
    enabled: String(env.CLAUDE_SDK_SCHEDULED_WAKEUP_HOLD ?? '').trim() !== '0',
    marginMs: positiveInt(env.CLAUDE_SDK_SCHEDULED_WAKEUP_MARGIN_MS, 60_000),
    totalMaxMs: positiveInt(env.CLAUDE_SDK_SCHEDULED_WAKEUP_TOTAL_MAX_MS, 6 * 3_600_000),
    maxPulses: positiveInt(env.CLAUDE_SDK_SCHEDULED_WAKEUP_MAX_PULSES, 48),
    listenerGraceMs: positiveInt(env.CLAUDE_SDK_SCHEDULED_WAKEUP_LISTENER_GRACE_MS, 30 * 60_000),
    listenerPollMs: positiveInt(env.CLAUDE_SDK_SCHEDULED_WAKEUP_LISTENER_POLL_MS, 60_000),
  };
}

/** Counts a run's wake-up budget: time since the first schedule and fired turns. */
export function createWakeupHoldBudget(config: WakeupHoldConfig, now: () => number = Date.now) {
  let firstScheduledAt: number | null = null;
  let pulses = 0;
  return {
    onScheduled(): void { firstScheduledAt ??= now(); },
    onFired(): void { pulses += 1; },
    /** Epoch ms the total cap ends, or null before any schedule. */
    totalCapAt(): number | null {
      return firstScheduledAt === null ? null : firstScheduledAt + config.totalMaxMs;
    },
    exhausted(): boolean {
      const capAt = this.totalCapAt();
      return pulses >= config.maxPulses || (capAt !== null && now() >= capAt);
    },
  };
}

export type WakeupHoldPlan = { delayMs: number; reason: string } | { release: string } | null;

/**
 * How long the input may stay open for the wake-ups `wake` names, or which reason
 * closes it now; null when no wake-up is pending.
 * @param wake - nextWakeAt / openEnded from the tracker
 * @param idleCapAt - the per-result background idle cap (epoch ms)
 */
export function planWakeupHold(wake: { nextWakeAt: number | null; openEnded: boolean },
  budget: ReturnType<typeof createWakeupHoldBudget>, config: WakeupHoldConfig,
  idleCapAt: number, now: number): WakeupHoldPlan {
  if (wake.nextWakeAt === null && !wake.openEnded) return null;
  if (!config.enabled) return { release: 'scheduled-wakeup-disabled' };
  if (budget.exhausted()) return { release: 'scheduled-wakeup-total-cap' };
  const totalAt = budget.totalCapAt() ?? now + config.totalMaxMs;
  // A recurring cron has no known end; only CronDelete or the total cap ends it.
  const candidates: Array<[number, string]> = wake.openEnded
    ? [[totalAt, 'scheduled-wakeup-total-cap']]
    : [[(wake.nextWakeAt as number) + config.marginMs, 'scheduled-wakeup-expired'],
      [idleCapAt, 'scheduled-wakeup-cap'], [totalAt, 'scheduled-wakeup-total-cap']];
  const [until, reason] = candidates.reduce((best, next) => (next[0] < best[0] ? next : best));
  return { delayMs: Math.max(0, until - now), reason };
}

/** Highest utilization (percent) of the session and weekly windows, or null when unknown. */
export function peakUsagePercent(summary: unknown): number | null {
  const record = (summary && typeof summary === 'object' ? summary : {}) as Record<string, any>;
  const values = [record.session?.utilization, record.weeklyAllModels?.utilization]
    .filter((value): value is number => typeof value === 'number' && Number.isFinite(value));
  return values.length > 0 ? Math.max(...values) : null;
}
