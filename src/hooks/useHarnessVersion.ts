import { useCallback, useEffect, useRef, useState } from 'react';

import type {
  HarnessAutoUpdateSettings,
  HarnessConfirmationRequired,
  HarnessRequiredAck,
  HarnessSnapshotSummary,
  HarnessSuppliedAck,
  HarnessUpdateAccepted,
  HarnessUpdateConflict,
  HarnessUpdateJob,
  HarnessVersionStatus as WireStatus,
} from '../../shared/harness-update.contract';
import { getIdentityBarrierSnapshot, subscribeIdentityBarrier } from '../components/auth/accountIdentityBarrier';
import type { AgentProvider } from '../components/settings/types/types';
import { authenticatedFetch } from '../utils/api';

import { isTerminalJob, mapUpdateJob, mapVersionStatus, normalizeHarnessProvider, type HarnessVersionState } from './harnessVersionMapping';

const JOB_POLL_MS = 1000;
const identityKey = () => { const snapshot = getIdentityBarrierSnapshot(); return `${snapshot.version}:${snapshot.phase}`; };

/** The action a pending 409 CONFIRMATION_REQUIRED belongs to, so `confirmPending` knows which route to resend. */
export type HarnessConfirmAction = 'update' | 'restore-compatible' | 'rollback';

/** Rollback needs its `jobId`/`scope` echoed back unchanged when the acks are resent (spec §9). */
export interface HarnessRollbackContext { jobId: string; scope: 'binary' | 'binary+data' }

export interface HarnessPendingConfirmation {
  action: HarnessConfirmAction;
  required: HarnessRequiredAck[];
  rollback?: HarnessRollbackContext;
}

/** A refused action outside the confirmation/in-progress flows (423/507/404/other 409 codes). */
export interface HarnessActionError { code: string; message: string }

type ActionOutcome = { kind: 'accepted'; jobId: string } | { kind: 'confirmation'; required: HarnessRequiredAck[] } | { kind: 'conflict'; activeJobId: string | null } | { kind: 'error'; code: string; message: string };

const bodyCode = (body: unknown): string | undefined => (body && typeof body === 'object' && 'code' in body ? String((body as { code?: unknown }).code ?? '') : undefined);
const bodyMessage = (body: unknown): string => (body && typeof body === 'object' && 'message' in body ? String((body as { message?: unknown }).message ?? '') : '');

export function useHarnessVersion(agent: AgentProvider, isOwner: boolean) {
  const provider = normalizeHarnessProvider(agent);
  const [state, setState] = useState<HarnessVersionState>({ status: 'checking' });
  const [confirmation, setConfirmation] = useState<HarnessPendingConfirmation | null>(null);
  const [actionError, setActionError] = useState<HarnessActionError | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [snapshots, setSnapshots] = useState<HarnessSnapshotSummary[] | null>(null);
  const epoch = useRef(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const previousOwner = useRef(isOwner);
  const clearTimer = useCallback(() => { if (timer.current) clearTimeout(timer.current); timer.current = null; }, []);
  const valid = useCallback((request: number, identity: string) => epoch.current === request && identityKey() === identity, []);

  const fetchStatus = useCallback(async (freshForRetry = false) => {
    const request = ++epoch.current; const identity = identityKey();
    setState(previous => ({ status: 'checking', version: previous.version, latestVersion: previous.latestVersion }));
    try {
      const response = await authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/version-status`);
      if (!valid(request, identity)) return;
      if (!response.ok) { setState({ status: response.status === 404 ? 'no-cli' : 'unknown' }); return; }
      const mapped = mapVersionStatus(await response.json() as WireStatus);
      if (valid(request, identity)) setState(freshForRetry && mapped.status === 'update-available' ? { ...mapped, retryReady: true } : mapped);
    } catch (error) {
      if (valid(request, identity) && (error as Error).name !== 'AbortError') setState({ status: 'unknown' });
    }
  }, [provider, valid]);

  const followJob = useCallback((jobId: string) => {
    if (!isOwner) return;
    clearTimer(); const request = ++epoch.current; const identity = identityKey();
    const poll = async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/update-jobs/${encodeURIComponent(jobId)}`);
        if (!valid(request, identity)) return;
        if (!response.ok) { setState({ status: 'unknown' }); return; }
        const job = await response.json() as HarnessUpdateJob;
        if (!valid(request, identity)) return;
        setState(mapUpdateJob(job));
        if (!isTerminalJob(job.status)) timer.current = setTimeout(() => void poll(), JOB_POLL_MS);
      } catch (error) {
        if (valid(request, identity) && (error as Error).name !== 'AbortError') timer.current = setTimeout(() => void poll(), JOB_POLL_MS);
      }
    };
    void poll();
  }, [clearTimer, isOwner, valid]);

  /** POST one harness action; classifies the response into the shapes every caller below needs. Never throws — network/abort errors surface as `error`. */
  const postAction = useCallback(async (url: string, body: Record<string, unknown>): Promise<ActionOutcome | null> => {
    const request = ++epoch.current; const identity = identityKey();
    try {
      const response = await authenticatedFetch(url, { method: 'POST', body: JSON.stringify(body) });
      if (!valid(request, identity)) return null;
      const json = await response.json().catch(() => ({})) as unknown;
      if (response.status === 409) {
        if (bodyCode(json) === 'CONFIRMATION_REQUIRED') {
          return { kind: 'confirmation', required: (json as HarnessConfirmationRequired).required ?? [] };
        }
        const conflict = json as HarnessUpdateConflict;
        return { kind: 'conflict', activeJobId: typeof conflict.activeJobId === 'string' && conflict.activeJobId.length > 0 ? conflict.activeJobId : null };
      }
      if (!response.ok) return { kind: 'error', code: bodyCode(json) ?? `http_${response.status}`, message: bodyMessage(json) };
      return { kind: 'accepted', jobId: (json as HarnessUpdateAccepted).jobId };
    } catch (error) {
      if (valid(request, identity) && (error as Error).name !== 'AbortError') return { kind: 'error', code: 'network', message: '' };
      return null;
    }
  }, [valid]);

  /** Runs one owner action end to end: accepted → follow the job; confirmation → surface the ack dialog; conflict/error → visible failure. `onConfirmed` re-issues the SAME action, only called by `confirmPending`/`refreshConfirmation` below. */
  const runAction = useCallback(async (action: HarnessConfirmAction, url: string, body: Record<string, unknown>, rollback?: HarnessRollbackContext) => {
    if (!isOwner) return;
    setActionError(null);
    setSubmitting(true);
    const outcome = await postAction(url, body);
    setSubmitting(false);
    if (!outcome) return;
    if (outcome.kind === 'accepted') { setConfirmation(null); followJob(outcome.jobId); return; }
    if (outcome.kind === 'confirmation') { setConfirmation({ action, required: outcome.required, rollback }); return; }
    if (outcome.kind === 'conflict') {
      setConfirmation(null);
      if (outcome.activeJobId) followJob(outcome.activeJobId);
      else setState(previous => ({ ...previous, status: 'failed', reason: 'conflict_missing_job', retryReady: false }));
      return;
    }
    setConfirmation(null);
    setActionError({ code: outcome.code, message: outcome.message });
    setState(previous => ({ ...previous, status: 'failed', reason: outcome.code, retryReady: false }));
  }, [followJob, isOwner, postAction]);

  const startUpdate = useCallback(async (acks?: HarnessSuppliedAck[]) => {
    await runAction('update', `/api/providers/${encodeURIComponent(provider)}/update`, acks ? { acks } : {});
  }, [provider, runAction]);

  const startRestoreCompatible = useCallback(async (acks?: HarnessSuppliedAck[]) => {
    await runAction('restore-compatible', `/api/providers/${encodeURIComponent(provider)}/restore-compatible`, acks ? { acks } : {});
  }, [provider, runAction]);

  const startRollback = useCallback(async (jobId: string, scope: 'binary' | 'binary+data', acks?: HarnessSuppliedAck[]) => {
    const body: Record<string, unknown> = { jobId, scope };
    if (acks) body.acks = acks;
    await runAction('rollback', `/api/providers/${encodeURIComponent(provider)}/rollback`, body, { jobId, scope });
  }, [provider, runAction]);

  /** Resends the pending action with every required ack's token — the caller (dialog) gathers the checkboxes first. */
  const confirmPending = useCallback(async (acks: HarnessSuppliedAck[]) => {
    if (!confirmation) return;
    if (confirmation.action === 'update') { await startUpdate(acks); return; }
    if (confirmation.action === 'restore-compatible') { await startRestoreCompatible(acks); return; }
    if (confirmation.rollback) await startRollback(confirmation.rollback.jobId, confirmation.rollback.scope, acks);
  }, [confirmation, startRestoreCompatible, startRollback, startUpdate]);

  /** A token expired before the owner finished checking every box: re-request the SAME action with no acks to mint fresh tokens (spec §9: facts change → fresh 409). */
  const refreshConfirmation = useCallback(async () => {
    if (!confirmation) return;
    if (confirmation.action === 'update') { await startUpdate(); return; }
    if (confirmation.action === 'restore-compatible') { await startRestoreCompatible(); return; }
    if (confirmation.rollback) await startRollback(confirmation.rollback.jobId, confirmation.rollback.scope);
  }, [confirmation, startRestoreCompatible, startRollback, startUpdate]);

  const cancelConfirmation = useCallback(() => setConfirmation(null), []);

  const startRecovery = useCallback(async (action: 'retry' | 'acknowledge') => {
    if (!isOwner) return;
    setActionError(null);
    setSubmitting(true);
    const request = ++epoch.current; const identity = identityKey();
    try {
      const response = await authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/recovery`, { method: 'POST', body: JSON.stringify({ action }) });
      if (!valid(request, identity)) return;
      const json = await response.json().catch(() => ({})) as { jobId?: string; code?: string; message?: string };
      if (!response.ok) { setActionError({ code: json.code ?? `http_${response.status}`, message: json.message ?? '' }); return; }
      if (typeof json.jobId === 'string') { followJob(json.jobId); return; }
      void fetchStatus();
    } catch (error) {
      if (valid(request, identity) && (error as Error).name !== 'AbortError') setActionError({ code: 'network', message: '' });
    } finally {
      if (valid(request, identity)) setSubmitting(false);
    }
  }, [fetchStatus, followJob, isOwner, provider, valid]);

  const loadSnapshots = useCallback(async () => {
    if (!isOwner) return;
    try {
      const response = await authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/snapshots`);
      if (!response.ok) { setSnapshots([]); return; }
      setSnapshots(await response.json() as HarnessSnapshotSummary[]);
    } catch {
      setSnapshots([]);
    }
  }, [isOwner, provider]);

  useEffect(() => {
    if (isOwner && state.status === 'running' && state.jobId && !timer.current) followJob(state.jobId);
  }, [followJob, isOwner, state.jobId, state.status]);

  useEffect(() => {
    const lostOwnerRole = previousOwner.current && !isOwner;
    previousOwner.current = isOwner;
    if (!lostOwnerRole) return;
    epoch.current += 1;
    clearTimer();
    setState({ status: 'checking' });
    setConfirmation(null);
    setActionError(null);
    setSnapshots(null);
    void fetchStatus();
  }, [clearTimer, fetchStatus, isOwner]);

  useEffect(() => {
    void fetchStatus();
    const unsubscribe = subscribeIdentityBarrier(() => {
      epoch.current += 1; clearTimer(); setState({ status: 'checking' });
      setConfirmation(null); setActionError(null); setSnapshots(null);
      if (getIdentityBarrierSnapshot().phase === 'stable') void fetchStatus();
    });
    return () => { epoch.current += 1; clearTimer(); unsubscribe(); };
  }, [clearTimer, fetchStatus]);

  return {
    state, checkNow: () => void fetchStatus(true), startUpdate,
    confirmation, confirmPending, refreshConfirmation, cancelConfirmation,
    actionError, submitting,
    startRestoreCompatible, startRollback, startRecovery,
    snapshots, loadSnapshots,
  };
}

const MIN_AUTO_UPDATE_MINUTES = 30;
const MAX_AUTO_UPDATE_MINUTES = 7 * 24 * 60;

function parseAutoUpdateSettings(value: unknown): HarnessAutoUpdateSettings | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const candidate = value as Partial<HarnessAutoUpdateSettings>;
  if (typeof candidate.enabled !== 'boolean'
    || !Number.isSafeInteger(candidate.intervalMinutes)
    || Number(candidate.intervalMinutes) < MIN_AUTO_UPDATE_MINUTES
    || Number(candidate.intervalMinutes) > MAX_AUTO_UPDATE_MINUTES
    || !(candidate.lastRunAt === null || typeof candidate.lastRunAt === 'string')
    || !(candidate.nextRunAt === null || typeof candidate.nextRunAt === 'string')) return null;
  return candidate as HarnessAutoUpdateSettings;
}

export type HarnessAutoUpdateDraft = Pick<HarnessAutoUpdateSettings, 'enabled' | 'intervalMinutes'>;

export function useHarnessAutoUpdateSettings(isOwner: boolean) {
  const [settings, setSettings] = useState<HarnessAutoUpdateSettings | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'error'>('idle');
  const epoch = useRef(0);
  const valid = useCallback((request: number, identity: string) => (
    request === epoch.current && identity === identityKey()
  ), []);

  const load = useCallback(async () => {
    if (!isOwner) return;
    const request = ++epoch.current;
    const identity = identityKey();
    setStatus('loading');
    try {
      const response = await authenticatedFetch('/api/providers/autoupdate-settings');
      if (!valid(request, identity)) return;
      if (!response.ok) throw new Error('read_failed');
      const body = await response.json() as unknown;
      if (!valid(request, identity)) return;
      const parsed = parseAutoUpdateSettings(body);
      if (!parsed) throw new Error('invalid_settings');
      setSettings(parsed);
      setStatus('idle');
    } catch (error) {
      if (valid(request, identity) && (error as Error).name !== 'AbortError') setStatus('error');
    }
  }, [isOwner, valid]);

  const save = useCallback(async (draft: HarnessAutoUpdateDraft) => {
    if (!isOwner || !settings) return;
    if (!Number.isSafeInteger(draft.intervalMinutes)
      || draft.intervalMinutes < MIN_AUTO_UPDATE_MINUTES
      || draft.intervalMinutes > MAX_AUTO_UPDATE_MINUTES) {
      setStatus('error');
      return;
    }
    const request = ++epoch.current;
    const identity = identityKey();
    setStatus('saving');
    try {
      const response = await authenticatedFetch('/api/providers/autoupdate-settings', {
        method: 'PUT', body: JSON.stringify(draft),
      });
      if (!valid(request, identity)) return;
      if (!response.ok) throw new Error('write_failed');
      const body = await response.json() as unknown;
      if (!valid(request, identity)) return;
      const parsed = parseAutoUpdateSettings(body);
      if (!parsed) throw new Error('invalid_settings');
      setSettings(parsed);
      setStatus('idle');
    } catch (error) {
      if (valid(request, identity) && (error as Error).name !== 'AbortError') setStatus('error');
    }
  }, [isOwner, settings, valid]);

  useEffect(() => {
    if (!isOwner) {
      epoch.current += 1;
      setSettings(null);
      setStatus('idle');
      return;
    }
    void load();
    const unsubscribe = subscribeIdentityBarrier(() => {
      epoch.current += 1;
      setSettings(null);
      setStatus('idle');
      if (getIdentityBarrierSnapshot().phase === 'stable') void load();
    });
    return () => {
      epoch.current += 1;
      unsubscribe();
    };
  }, [isOwner, load]);
  return { settings, status, save, reload: load };
}
