import type { HarnessUpdateJob, HarnessVersionStatus as WireStatus } from '../../shared/harness-update.contract';

export type HarnessVersionStatus = 'checking' | 'current' | 'unverified' | 'update-available' | 'unknown' | 'managed-external' | 'no-cli' | 'queued' | 'running' | 'succeeded' | 'failed' | 'skipped-live' | 'pinned-refused';
export type HarnessVersionState = {
  status: HarnessVersionStatus; version?: string; latestVersion?: string; reason?: string;
  checkedAt?: string; jobId?: string; phase?: HarnessUpdateJob['phase']; progressPercent?: number;
  log?: string[]; errorMessage?: string; retryReady?: boolean;
};

export function normalizeHarnessProvider(provider: string): string {
  if (provider === 'agy') return 'antigravity';
  if (provider === 'cursor-agent') return 'cursor';
  if (provider === 'glm') return 'opencode';
  return provider;
}

export function mapVersionStatus(wire: WireStatus): HarnessVersionState {
  const common = { version: wire.installedVersion ?? undefined, latestVersion: wire.latestVersion ?? undefined, reason: wire.reason ?? undefined, checkedAt: wire.checkedAt };
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
  return { ...common, status: 'failed', retryReady: false };
}

export function mayRetryAfterFreshStatus(state: HarnessVersionState): boolean {
  return state.status === 'failed' && state.reason !== 'recovery_failed' && state.reason !== 'rollback-unavailable' && state.reason !== 'rollback_unavailable' && state.retryReady === true;
}
