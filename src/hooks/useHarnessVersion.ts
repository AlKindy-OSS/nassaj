import { useCallback, useEffect, useRef, useState } from 'react';
import type { HarnessAutoUpdateSettings, HarnessUpdateAccepted, HarnessUpdateConflict, HarnessUpdateJob, HarnessVersionStatus as WireStatus } from '../../shared/harness-update.contract';
import { getIdentityBarrierSnapshot, subscribeIdentityBarrier } from '../components/auth/accountIdentityBarrier';
import type { AgentProvider } from '../components/settings/types/types';
import { authenticatedFetch } from '../utils/api';
import { isTerminalJob, mapUpdateJob, mapVersionStatus, normalizeHarnessProvider, type HarnessVersionState } from './harnessVersionMapping';

const JOB_POLL_MS = 1000;
const identityKey = () => { const snapshot = getIdentityBarrierSnapshot(); return `${snapshot.version}:${snapshot.phase}`; };

export function useHarnessVersion(agent: AgentProvider, isOwner: boolean) {
  const provider = normalizeHarnessProvider(agent);
  const [state, setState] = useState<HarnessVersionState>({ status: 'checking' });
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

  const startUpdate = useCallback(async () => {
    if (!isOwner) return;
    const request = ++epoch.current; const identity = identityKey();
    setState(previous => ({ ...previous, status: 'queued', phase: 'queued', progressPercent: 0, log: [] }));
    try {
      const response = await authenticatedFetch(`/api/providers/${encodeURIComponent(provider)}/update`, { method: 'POST' });
      if (!valid(request, identity)) return;
      if (response.status === 409) {
        const conflict = await response.json() as HarnessUpdateConflict;
        if (!valid(request, identity)) return;
        if (typeof conflict.activeJobId === 'string' && conflict.activeJobId.length > 0) {
          followJob(conflict.activeJobId);
        } else {
          setState(previous => ({ ...previous, status: 'failed', reason: 'conflict_missing_job', retryReady: false }));
        }
        return;
      }
      if (!response.ok) { setState(previous => ({ ...previous, status: 'failed', reason: `http_${response.status}`, retryReady: false })); return; }
      const accepted = await response.json() as HarnessUpdateAccepted;
      if (valid(request, identity)) followJob(accepted.jobId);
    } catch (error) {
      if (valid(request, identity) && (error as Error).name !== 'AbortError') setState(previous => ({ ...previous, status: 'failed', reason: 'network', retryReady: false }));
    }
  }, [followJob, isOwner, provider, valid]);

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
    void fetchStatus();
  }, [clearTimer, fetchStatus, isOwner]);

  useEffect(() => {
    void fetchStatus();
    const unsubscribe = subscribeIdentityBarrier(() => {
      epoch.current += 1; clearTimer(); setState({ status: 'checking' });
      if (getIdentityBarrierSnapshot().phase === 'stable') void fetchStatus();
    });
    return () => { epoch.current += 1; clearTimer(); unsubscribe(); };
  }, [clearTimer, fetchStatus]);
  return { state, checkNow: () => void fetchStatus(true), startUpdate };
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
