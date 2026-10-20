import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.fn();
vi.mock('../utils/api', () => ({ authenticatedFetch: (...args: unknown[]) => fetchMock(...args) }));
vi.mock('../components/auth/accountIdentityBarrier', () => ({
  getIdentityBarrierSnapshot: () => ({ version: '1', phase: 'stable' }),
  subscribeIdentityBarrier: () => () => {},
}));

import { HARNESS_INSTALLED_EVENT } from './harnessJobPoller';
import { useHarnessInstall } from './useHarnessInstall';

const response = (body: unknown, status = 200) => Promise.resolve({ ok: status >= 200 && status < 300, status, json: async () => body } as Response);
const job = (over: Record<string, unknown>) => ({ jobId: 'job-1', provider: 'codex', kind: 'install', status: 'running', phase: 'downloading', percent: 15, log: [], fromVersion: null, toVersion: null, error: null, ...over });

describe('useHarnessInstall', () => {
  beforeEach(() => { fetchMock.mockReset(); });
  afterEach(() => { cleanup(); vi.useRealTimers(); });

  it('goes progress → success and calls onInstalled exactly once', async () => {
    const jobs = [
      job({ phase: 'downloading', percent: 15, log: ['fetch'] }),
      job({ phase: 'installing', percent: 60, log: ['fetch', 'run'] }),
      job({ status: 'succeeded', phase: 'done', percent: 100, toVersion: '0.50.0' }),
      job({ status: 'succeeded', phase: 'done', percent: 100, toVersion: '0.50.0' }),
    ];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ jobId: 'job-1', provider: 'codex', status: 'running' }, 202);
      return response(jobs.shift() ?? jobs[jobs.length - 1]);
    });
    const onInstalled = vi.fn();
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail.provider);
    window.addEventListener(HARNESS_INSTALLED_EVENT, listener);
    const { result } = renderHook(() => useHarnessInstall('codex', onInstalled));
    await act(async () => result.current.start());
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/codex/install', expect.objectContaining({ method: 'POST' }));
    await waitFor(() => expect(result.current.state.phase).toBe('downloading'));
    expect(result.current.state.status).toBe('running');
    await waitFor(() => expect(result.current.state.status).toBe('succeeded'), { timeout: 4000 });
    expect(result.current.state.version).toBe('0.50.0');
    expect(onInstalled).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['codex']);
    window.removeEventListener(HARNESS_INSTALLED_EVENT, listener);
  });

  it('resumes polling the active job on 409 HARNESS_UPDATE_IN_PROGRESS', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ code: 'HARNESS_UPDATE_IN_PROGRESS', message: 'busy', activeJobId: 'job-active' }, 409);
      return response(job({ jobId: 'job-active', phase: 'verifying', percent: 90 }));
    });
    const { result } = renderHook(() => useHarnessInstall('opencode'));
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state.percent).toBe(90));
    expect(fetchMock).toHaveBeenCalledWith('/api/providers/update-jobs/job-active');
    expect(result.current.state.status).toBe('running');
  });

  it('shows busy-other and never reports install success when the 409 job is an update', async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') return response({ code: 'HARNESS_UPDATE_IN_PROGRESS', message: 'busy', activeJobId: 'job-update' }, 409);
      return response(job({ jobId: 'job-update', kind: undefined, status: 'succeeded', phase: 'done', percent: 100, toVersion: '1.0.0' }));
    });
    const onInstalled = vi.fn();
    const events: string[] = [];
    const listener = (event: Event) => events.push((event as CustomEvent).detail.provider);
    window.addEventListener(HARNESS_INSTALLED_EVENT, listener);
    const { result } = renderHook(() => useHarnessInstall('codex', onInstalled));
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('busy-other'));
    expect(onInstalled).not.toHaveBeenCalled();
    expect(events).toEqual([]);
    window.removeEventListener(HARNESS_INSTALLED_EVENT, listener);
  });

  it('surfaces a failed job with its Arabic message and allows retry', async () => {
    let posts = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') { posts += 1; return response({ jobId: `job-${posts}`, provider: 'codex', status: 'running' }, 202); }
      return response(job({ status: 'failed', phase: 'done', error: { code: 'install_timeout', message: 'timed out', messageAr: 'انتهت المهلة' } }));
    });
    const onInstalled = vi.fn();
    const { result } = renderHook(() => useHarnessInstall('codex', onInstalled));
    await act(async () => result.current.start());
    await waitFor(() => expect(result.current.state.status).toBe('failed'));
    expect(result.current.state.errorCode).toBe('install_timeout');
    expect(result.current.state.errorMessageAr).toBe('انتهت المهلة');
    await act(async () => result.current.start());
    expect(posts).toBe(2);
    expect(onInstalled).not.toHaveBeenCalled();
  });

  it('maps a refusal without a job to a failed state carrying its code', async () => {
    fetchMock.mockImplementation(() => response({ code: 'HARNESS_OVERRIDE_SET', message: 'override' }, 409));
    const { result } = renderHook(() => useHarnessInstall('codex'));
    await act(async () => result.current.start());
    expect(result.current.state).toMatchObject({ status: 'failed', errorCode: 'HARNESS_OVERRIDE_SET' });
  });
});
