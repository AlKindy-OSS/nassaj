import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
let identity = { version: '1', phase: 'stable' };
let identityListener: (() => void) | null = null;
vi.mock('../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../components/auth/accountIdentityBarrier', () => ({
  getIdentityBarrierSnapshot: () => identity,
  subscribeIdentityBarrier: (listener: () => void) => { identityListener = listener; return () => { identityListener = null; }; },
}));

import { useHarnessAutoUpdateSettings, useHarnessVersion } from './useHarnessVersion';

const response = (body: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
const statusBody = { provider: 'codex', state: 'updatable', installedVersion: '1.0.0', latestVersion: '2.0.0', upToDate: false, updatable: true, reason: null, checkedAt: '2026-09-24T00:00:00Z', updating: false, activeJobId: null };

describe('useHarnessVersion authorization and fencing', () => {
  beforeEach(() => { fetchMock.mockReset(); identity = { version: '1', phase: 'stable' }; identityListener = null; });
  afterEach(() => cleanup());

  it('shows status to a member without calling owner job or settings endpoints', async () => {
    fetchMock.mockImplementation(() => response(statusBody));
    const { result } = renderHook(() => useHarnessVersion('codex', false));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe('/api/providers/codex/version-status');
  });

  it('follows the active job returned by a 409 and exposes phase/log progress', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ activeJobId: 'job-active' }, 409);
      if (url.includes('/update-jobs/')) return response({ jobId: 'job-active', provider: 'codex', status: 'running', phase: 'verifying', percent: 80, log: ['safe line'], fromVersion: '1', toVersion: '2', error: null });
      return response(statusBody);
    });
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    await waitFor(() => expect(result.current.state.phase).toBe('verifying'));
    expect(result.current.state.log).toEqual(['safe line']);
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/update-jobs/job-active');
  });

  it('clears job logs immediately and discards a late old-identity response', async () => {
    let resolveJob!: (value: Response) => void;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ jobId: 'job-a', provider: 'codex', status: 'queued' });
      if (url.includes('/update-jobs/')) return new Promise<Response>((resolve) => { resolveJob = resolve; });
      return response(statusBody);
    });
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    await act(async () => { identity = { version: '2', phase: 'committed' }; identityListener?.(); });
    expect(result.current.state).toEqual({ status: 'checking' });
    await act(async () => resolveJob({ ok: true, status: 200, json: async () => ({ jobId: 'job-a', provider: 'codex', status: 'running', phase: 'updating', percent: 50, log: ['old account'], fromVersion: '1', toVersion: '2', error: null }) } as Response));
    expect(result.current.state.log).toBeUndefined();
  });

  it('does not read scheduler settings for members and never writes during owner load', async () => {
    const member = renderHook(() => useHarnessAutoUpdateSettings(false));
    await act(async () => Promise.resolve());
    expect(fetchMock).not.toHaveBeenCalled();
    member.unmount();
    fetchMock.mockImplementation(() => response({ enabled: true, intervalMinutes: 720, lastRunAt: null, nextRunAt: null }));
    const owner = renderHook(() => useHarnessAutoUpdateSettings(true));
    await waitFor(() => expect(owner.result.current.settings?.intervalMinutes).toBe(720));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1]).toBeUndefined();
  });

  it('turns a 409 without activeJobId into a visible local conflict that requires GET recheck', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'POST'
      ? response({}, 409)
      : response(statusBody));
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    expect(result.current.state).toMatchObject({ status: 'failed', reason: 'conflict_missing_job', retryReady: false });
    expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
  });

  it('drops delayed settings JSON after identity switch and after unmount', async () => {
    let resolveJson!: (value: unknown) => void;
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { resolveJson = resolve; }) } as Response);
    const first = renderHook(() => useHarnessAutoUpdateSettings(true));
    await waitFor(() => expect(resolveJson).toBeTypeOf('function'));
    await act(async () => { identity = { version: '2', phase: 'committed' }; identityListener?.(); });
    await act(async () => resolveJson({ enabled: true, intervalMinutes: 720, lastRunAt: null, nextRunAt: null }));
    expect(first.result.current.settings).toBeNull();
    first.unmount();

    identity = { version: '3', phase: 'stable' };
    let resolveUnmounted!: (value: unknown) => void;
    fetchMock.mockResolvedValue({ ok: true, status: 200, json: () => new Promise(resolve => { resolveUnmounted = resolve; }) } as Response);
    const second = renderHook(() => useHarnessAutoUpdateSettings(true));
    await waitFor(() => expect(resolveUnmounted).toBeTypeOf('function'));
    second.unmount();
    await act(async () => resolveUnmounted({ enabled: false, intervalMinutes: 60, lastRunAt: null, nextRunAt: null }));
    expect(fetchMock).toHaveBeenCalled();
  });

  it('saves enabled and interval only on explicit save and preserves server state on failure', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => init?.method === 'PUT'
      ? response({ error: 'failed' }, 500)
      : response({ enabled: true, intervalMinutes: 720, lastRunAt: null, nextRunAt: null }));
    const { result } = renderHook(() => useHarnessAutoUpdateSettings(true));
    await waitFor(() => expect(result.current.settings?.intervalMinutes).toBe(720));
    expect(fetchMock).toHaveBeenCalledTimes(1);
    await act(async () => result.current.save({ enabled: false, intervalMinutes: 60 }));
    expect(fetchMock).toHaveBeenLastCalledWith('/api/providers/autoupdate-settings', {
      method: 'PUT', body: JSON.stringify({ enabled: false, intervalMinutes: 60 }),
    });
    expect(result.current.status).toBe('error');
    expect(result.current.settings).toMatchObject({ enabled: true, intervalMinutes: 720 });
  });


  it('surfaces a 409 CONFIRMATION_REQUIRED as a pending confirmation and resends with the acked tokens', async () => {
    const required = [{ kind: 'pinBreak', token: 'tok-1', expiresAt: Date.now() + 300_000, textEn: 'en', textAr: 'ar', facts: {} }];
    let resendBody: unknown;
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        const parsed = init.body ? JSON.parse(init.body as string) : {};
        if (!parsed.acks) return response({ code: 'CONFIRMATION_REQUIRED', required }, 409);
        resendBody = parsed;
        return response({ jobId: 'job-confirmed', provider: 'codex', status: 'queued' }, 202);
      }
      if (_url.includes('/update-jobs/')) return response({ jobId: 'job-confirmed', provider: 'codex', status: 'running', phase: 'updating', percent: 10, log: [], fromVersion: '1', toVersion: '2', error: null });
      return response(statusBody);
    });
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    await waitFor(() => expect(result.current.confirmation).not.toBeNull());
    expect(result.current.confirmation?.required).toEqual(required);
    await act(async () => result.current.confirmPending([{ kind: 'pinBreak', token: 'tok-1' }]));
    expect(resendBody).toEqual({ acks: [{ kind: 'pinBreak', token: 'tok-1' }] });
    expect(result.current.confirmation).toBeNull();
    await waitFor(() => expect(result.current.state.phase).toBe('updating'));
  });

  it('exposes a 423/507 action refusal as actionError and a visible failed status', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? response({ code: 'STORE_IN_USE', message: 'busy' }, 423)
      : response(statusBody)));
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    expect(result.current.actionError).toEqual({ code: 'STORE_IN_USE', message: 'busy' });
    expect(result.current.state).toMatchObject({ status: 'failed', reason: 'STORE_IN_USE', retryReady: false });
  });

  it('B-1468: a 423 STORE_ACCESS_UNPROVABLE threads its unchecked details through actionError', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? response({ code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable', uncheckedProcesses: [{ pid: 4242, comm: 'sqlite3' }] }, 423)
      : response(statusBody)));
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    expect(result.current.actionError).toEqual({
      code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable',
      unchecked: { processes: [{ pid: 4242, comm: 'sqlite3' }], total: 1 },
    });
  });

  it('B-1468: a 423 STORE_ACCESS_UNPROVABLE with no processes carries none (store-privacy refusal)', async () => {
    fetchMock.mockImplementation((_url: string, init?: RequestInit) => (init?.method === 'POST'
      ? response({ code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable' }, 423)
      : response(statusBody)));
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    expect(result.current.actionError).toEqual({ code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable' });
    expect(result.current.actionError?.unchecked).toBeUndefined();
  });

  it('B-1468: a job that fails with STORE_ACCESS_UNPROVABLE carries job.error details into state', async () => {
    const jobError = {
      code: 'STORE_ACCESS_UNPROVABLE', message: 'unprovable', messageAr: 'x',
      uncheckedProcesses: [{ pid: 7, comm: 'sqlite3', reason: 'fd_unreadable' }, { pid: 8, comm: 'bad', reason: 'nope' }],
      uncheckedProcessCount: 5,
    };
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ jobId: 'job-f', provider: 'codex', status: 'queued' }, 202);
      if (url.includes('/update-jobs/')) return response({ jobId: 'job-f', provider: 'codex', status: 'failed', phase: 'done', percent: 100, log: [], fromVersion: '1', toVersion: '2', error: jobError });
      return response(statusBody);
    });
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.actionError).toBeNull();
    expect(result.current.state).toMatchObject({
      reason: 'STORE_ACCESS_UNPROVABLE',
      // An unknown reason value is dropped, not shown.
      unchecked: { processes: [{ pid: 7, comm: 'sqlite3', reason: 'fd_unreadable' }, { pid: 8, comm: 'bad' }], total: 5 },
    });
    expect(result.current.state.unchecked?.processes[1]).not.toHaveProperty('reason');
  });

  it('restore-compatible and rollback post their own routes and bodies', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST' && url.endsWith('/restore-compatible')) return response({ jobId: 'job-rc', provider: 'opencode', status: 'queued' }, 202);
      if (init?.method === 'POST' && url.endsWith('/rollback')) return response({ jobId: 'job-rb', provider: 'opencode', status: 'queued' }, 202);
      if (url.includes('/update-jobs/')) return response({ jobId: 'job-rc', provider: 'opencode', status: 'succeeded', phase: 'done', percent: 100, log: [], fromVersion: '1', toVersion: '1', error: null });
      return response({ ...statusBody, provider: 'opencode' });
    });
    const { result } = renderHook(() => useHarnessVersion('opencode', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startRestoreCompatible());
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/opencode/restore-compatible', { method: 'POST', body: JSON.stringify({}) });
    await act(async () => result.current.startRollback('job-prior', 'binary+data'));
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/opencode/rollback', { method: 'POST', body: JSON.stringify({ jobId: 'job-prior', scope: 'binary+data' }) });
  });

  it('recovery posts the action and follows the job when one is returned', async () => {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith('/recovery')) return response({ jobId: 'job-recover', provider: 'codex', status: 'queued' }, 202);
      if (url.includes('/update-jobs/')) return response({ jobId: 'job-recover', provider: 'codex', status: 'running', phase: 'recovering', percent: 50, log: [], fromVersion: '1', toVersion: '1', error: null });
      return response(statusBody);
    });
    const { result } = renderHook(() => useHarnessVersion('codex', true));
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startRecovery('retry'));
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/codex/recovery', { method: 'POST', body: JSON.stringify({ action: 'retry' }) });
    await waitFor(() => expect(result.current.state.phase).toBe('recovering'));
  });

  it('owner downgrade aborts delayed job JSON, clears logs, and performs only a public status GET', async () => {
    let resolveJobJson!: (value: unknown) => void;
    let jobReads = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ jobId: 'job-role', provider: 'codex', status: 'queued' }, 202);
      if (url.includes('/update-jobs/')) {
        jobReads += 1;
        return Promise.resolve({ ok: true, status: 200, json: () => new Promise(resolve => { resolveJobJson = resolve; }) } as Response);
      }
      return response(statusBody);
    });
    const { result, rerender } = renderHook(({ owner }) => useHarnessVersion('codex', owner), { initialProps: { owner: true } });
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => result.current.startUpdate());
    await waitFor(() => expect(resolveJobJson).toBeTypeOf('function'));
    rerender({ owner: false });
    await waitFor(() => expect(result.current.state.status).toBe('update-available'));
    await act(async () => resolveJobJson({ jobId: 'job-role', provider: 'codex', status: 'running', phase: 'updating', percent: 50, log: ['owner-only log'], fromVersion: '1', toVersion: '2', error: null }));
    expect(result.current.state.log).toBeUndefined();
    await act(async () => new Promise(resolve => setTimeout(resolve, 1_100)));
    expect(jobReads).toBe(1);
    expect(fetchMock.mock.calls.filter(call => call[1]?.method === 'POST')).toHaveLength(1);
    expect(fetchMock.mock.calls.at(-1)?.[0]).toBe('/api/providers/codex/version-status');
  });

});
