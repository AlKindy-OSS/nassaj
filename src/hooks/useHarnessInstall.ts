import { useCallback, useEffect, useRef, useState } from 'react';

import type { InstallableHarnessId } from '../../shared/harness-install.contract';
import type {
  HarnessRequiredAck,
  HarnessSuppliedAck,
  HarnessUpdateJob,
  HarnessUpdateJobPhase,
} from '../../shared/harness-update.contract';
import { getIdentityBarrierSnapshot, subscribeIdentityBarrier } from '../components/auth/accountIdentityBarrier';
import { authenticatedFetch } from '../utils/api';

import { HARNESS_INSTALLED_EVENT, pollHarnessJob } from './harnessJobPoller';

/**
 * `busy-other`: the harness lease is held by a non-install job (update, rollback…).
 * `confirming`: the server needs the owner's acknowledgement first (ADR-215 stage B).
 */
export type HarnessInstallStatus = 'idle' | 'starting' | 'running' | 'succeeded' | 'failed' | 'busy-other' | 'confirming';

/** View state of one owner-started CLI install (T-2062). */
export interface HarnessInstallState {
  status: HarnessInstallStatus;
  phase?: HarnessUpdateJobPhase;
  percent: number;
  log: string[];
  version?: string;
  /** Refusal code (POST) or job error code; drives the i18n message. */
  errorCode?: string;
  errorMessage?: string;
  errorMessageAr?: string;
  /** Server-built acknowledgements of a 409 CONFIRMATION_REQUIRED. */
  required?: HarnessRequiredAck[];
}

const identityKey = () => { const snapshot = getIdentityBarrierSnapshot(); return `${snapshot.version}:${snapshot.phase}`; };

const IDLE: HarnessInstallState = { status: 'idle', percent: 0, log: [] };

type Refusal = { code?: unknown; message?: unknown; activeJobId?: unknown; required?: unknown };

const text = (value: unknown): string | undefined => (typeof value === 'string' && value.length > 0 ? value : undefined);

function mapInstallJob(job: HarnessUpdateJob): HarnessInstallState {
  const base = { phase: job.phase, percent: job.percent, log: job.log ?? [] };
  if (job.status === 'queued' || job.status === 'running') return { ...base, status: 'running' };
  if (job.status === 'succeeded') return { ...base, status: 'succeeded', percent: 100, version: job.toVersion ?? undefined };
  return {
    ...base, status: 'failed',
    errorCode: job.error?.code ?? 'install_failed', errorMessage: job.error?.message, errorMessageAr: job.error?.messageAr,
  };
}

/**
 * Owner-only install of a missing harness CLI: POST /api/providers/:id/install,
 * then the shared job poller. A 409 HARNESS_UPDATE_IN_PROGRESS with an
 * `activeJobId` resumes that job instead of failing. `onInstalled` fires once
 * per succeeded job; the install also tells version/model views to refetch.
 */
export function useHarnessInstall(provider: InstallableHarnessId | null, onInstalled?: () => void) {
  const [state, setState] = useState<HarnessInstallState>(IDLE);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const notified = useRef<string | null>(null);
  /** Epoch of the POST still awaiting its response; blocks a duplicate submit (double-click). */
  const inFlight = useRef<number | null>(null);
  const onInstalledRef = useRef(onInstalled);
  onInstalledRef.current = onInstalled;

  const clearTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);

  const follow = useCallback((jobId: string) => {
    clearTimer();
    const request = ++epoch.current; const identity = identityKey();
    setState(previous => ({ ...previous, status: 'running' }));
    pollHarnessJob(jobId, {
      isValid: () => epoch.current === request && identityKey() === identity,
      onJob: (job) => {
        // A 409 can point at an update/rollback job: never report it as an install.
        if (job.kind !== 'install') { epoch.current += 1; clearTimer(); setState({ ...IDLE, status: 'busy-other' }); return; }
        const next = mapInstallJob(job);
        setState(next);
        if (next.status !== 'succeeded' || notified.current === jobId) return;
        notified.current = jobId;
        window.dispatchEvent(new CustomEvent(HARNESS_INSTALLED_EVENT, { detail: { provider } }));
        window.dispatchEvent(new Event('local-models-changed'));
        onInstalledRef.current?.();
      },
      onHttpError: (status) => setState(previous => ({ ...previous, status: 'failed', errorCode: `http_${status}` })),
      setTimer: (next) => { timer.current = next; },
    });
  }, [clearTimer, provider]);

  const start = useCallback(async (acks?: HarnessSuppliedAck[]) => {
    if (!provider || inFlight.current !== null) return;
    clearTimer();
    const request = ++epoch.current;
    inFlight.current = request;
    // A confirmed resend keeps the acks so the dialog stays up, disabled, until the server answers.
    setState(previous => (acks ? { ...IDLE, status: 'starting', required: previous.required } : { ...IDLE, status: 'starting' }));
    try {
      const response = await authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/install`, { method: 'POST', body: JSON.stringify(acks ? { acks } : {}) });
      if (epoch.current !== request) return;
      const body = await response.json().catch(() => ({})) as Refusal & { jobId?: unknown };
      if (epoch.current !== request) return;
      const jobId = text(body.jobId);
      if (response.ok && jobId) { follow(jobId); return; }
      if (response.status === 409 && body.code === 'CONFIRMATION_REQUIRED' && Array.isArray(body.required)) {
        setState({ ...IDLE, status: 'confirming', required: body.required as HarnessRequiredAck[] });
        return;
      }
      const activeJobId = text(body.activeJobId);
      if (response.status === 409 && body.code === 'HARNESS_UPDATE_IN_PROGRESS' && activeJobId) { follow(activeJobId); return; }
      setState({ ...IDLE, status: 'failed', errorCode: text(body.code) ?? `http_${response.status}`, errorMessage: text(body.message) });
    } catch (error) {
      if (epoch.current === request && (error as Error).name !== 'AbortError') setState({ ...IDLE, status: 'failed', errorCode: 'network' });
    } finally {
      if (inFlight.current === request) inFlight.current = null;
    }
  }, [clearTimer, follow, provider]);

  useEffect(() => () => { epoch.current += 1; clearTimer(); }, [clearTimer]);
  useEffect(() => {
    const reset = () => { epoch.current += 1; inFlight.current = null; clearTimer(); setState(IDLE); };
    reset();
    return subscribeIdentityBarrier(reset);
  }, [clearTimer, provider]);

  const cancel = useCallback(() => { epoch.current += 1; inFlight.current = null; clearTimer(); setState(IDLE); }, [clearTimer]);

  return { state, start, cancel };
}
