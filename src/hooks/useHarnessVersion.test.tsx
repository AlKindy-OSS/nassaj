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
