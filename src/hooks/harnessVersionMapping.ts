import type { HarnessCompatibility, HarnessRestoreCompatibleOffer, HarnessUpdateJob, HarnessUpdateNotices, HarnessVersionDrift, HarnessVersionStatus as WireStatus } from '../../shared/harness-update.contract';

export type HarnessVersionStatus = 'checking' | 'current' | 'unverified' | 'update-available' | 'unknown' | 'managed-external' | 'no-cli' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped-live' | 'pinned-refused' | 'noop' | 'rolled-back' | 'rollback-failed';
export type HarnessVersionState = {
  status: HarnessVersionStatus; version?: string; latestVersion?: string; reason?: string;
  checkedAt?: string; jobId?: string; phase?: HarnessUpdateJob['phase']; progressPercent?: number;
  log?: string[]; errorMessage?: string; retryReady?: boolean;
  /** T-1871 stage 2 (ADR-159 Addendum 4), display-only: compatibility verdicts + drift. */
  compatibility?: HarnessCompatibility; targetCompatibility?: HarnessCompatibility; drift?: HarnessVersionDrift;
  /** T-1871 stage 4: dialog facts, restore-compatible offer, scheduler-skip flag. */
  notices?: HarnessUpdateNotices; restoreCompatible?: HarnessRestoreCompatibleOffer; manualOnly?: boolean;
};

export function normalizeHarnessProvider(provider: string): string {
  if (provider === 'agy') return 'antigravity';
  if (provider === 'cursor-agent') return 'cursor';
  if (provider === 'glm') return 'opencode';
  return provider;
}

export function mapVersionStatus(wire: WireStatus): HarnessVersionState {
  const common = {
    version: wire.installedVersion ?? undefined, latestVersion: wire.latestVersion ?? undefined, reason: wire.reason ?? undefined, checkedAt: wire.checkedAt,
    compatibility: wire.compatibility, targetCompatibility: wire.targetCompatibility, drift: wire.drift,
    notices: wire.notices, restoreCompatible: wire.restoreCompatible, manualOnly: wire.manualOnly,
  };
  if (wire.updating) return { ...common, status: 'running', jobId: wire.activeJobId ?? undefined };
  if (wire.reason === 'recovery_failed') return { ...common, status: 'failed', retryReady: false };
  if (wire.state !== 'updatable') return { ...common, status: wire.state };
  if (wire.reason === 'pinned') return { ...common, status: 'pinned-refused' };
  if (!wire.updatable) return { ...common, status: 'managed-external' };
  if (wire.upToDate === false) return { ...common, status: 'update-available' };
  if (wire.upToDate === true) return { ...common, status: 'current' };
  return { ...common, status: 'unverified' };
}

export const isTerminalJob = (status: HarnessUpdateJob['status']): boolean => status !== 'queued' && status !== 'running';

export function mapUpdateJob(job: HarnessUpdateJob): HarnessVersionState {
  const common = { jobId: job.jobId, version: job.fromVersion ?? undefined, latestVersion: job.toVersion ?? undefined, phase: job.phase, progressPercent: job.percent, log: job.log, reason: job.error?.code, errorMessage: job.error?.message };
  if (job.status === 'queued' || job.status === 'running') return { ...common, status: job.status };
  if (job.status === 'succeeded') return { ...common, status: 'succeeded', version: job.toVersion ?? job.fromVersion ?? undefined };
  if (job.status === 'skipped_live_session') return { ...common, status: 'skipped-live' };
  if (job.status === 'refused_pinned') return { ...common, status: 'pinned-refused' };
  if (job.status === 'noop') return { ...common, status: 'noop', version: job.fromVersion ?? undefined };
  if (job.status === 'rolled_back') return { ...common, status: 'rolled-back', version: job.fromVersion ?? undefined };
  if (job.status === 'rollback_failed') return { ...common, status: 'rollback-failed', retryReady: false };
  return { ...common, status: 'failed', retryReady: false };
}

/** True when the harness is stuck out of a failed automatic restore and needs the owner-only recovery action (spec §9, qa condition 1). */
export function needsRecovery(state: HarnessVersionState): boolean {
  return state.status === 'rollback-failed';
}

export function mayRetryAfterFreshStatus(state: HarnessVersionState): boolean {
  return state.status === 'failed' && state.reason !== 'recovery_failed' && state.reason !== 'rollback-unavailable' && state.reason !== 'rollback_unavailable' && state.retryReady === true;
}

/**
 * Compatibility reason codes this client names explicitly (T-1871 / ADR-159
 * Addendum 4). A code outside this set that still ends in `-blocked` (a new
 * blocked mode shipped server-side first) falls back to a generic "mode
 * blocked" message instead of leaking the raw machine code; anything else
 * falls back to a neutral "no detail" message.
 */
const KNOWN_COMPAT_REASONS = new Set([
  'pin-match', 'pin-armed-blocked', 'glm-carrier-blocked', 'pin-mismatch-unreviewed',
  'baseline-match', 'not-baselined', 'no-compat-data', 'version-unknown',
]);

export function compatReasonKey(reason: string): string {
  if (KNOWN_COMPAT_REASONS.has(reason)) return reason;
  if (reason.endsWith('-blocked')) return 'mode-blocked';
  return 'unknown';
}
