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

  it('turns 409 CONFIRMATION_REQUIRED into confirming, resends the acks, and cancel returns to idle (ADR-215)', async () => {
    const required = [{ kind: 'systemCopy', token: 't1', expiresAt: Date.now() + 60_000, textEn: 'e', textAr: 'ع', facts: {} }];
    const bodies: string[] = [];
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method === 'POST') {
        bodies.push(String(init.body));
        return bodies.length === 1
          ? response({ code: 'CONFIRMATION_REQUIRED', message: 'confirm', required }, 409)
          : response({ jobId: 'job-1', provider: 'claude', status: 'running' }, 202);
      }
      return response(job({ provider: 'claude' }));
    });
    const { result } = renderHook(() => useHarnessInstall('claude'));
    await act(async () => result.current.start());
    expect(result.current.state.status).toBe('confirming');
    expect(result.current.state.required).toEqual(required);
    act(() => result.current.cancel());
    expect(result.current.state.status).toBe('idle');
    await act(async () => result.current.start());
    await act(async () => result.current.start([{ kind: 'systemCopy', token: 't1' }]));
    expect(JSON.parse(bodies[0])).toEqual({});
    expect(JSON.parse(bodies[2])).toEqual({ acks: [{ kind: 'systemCopy', token: 't1' }] });
    await waitFor(() => expect(result.current.state.status).toBe('running'));
  });

  it('sends one POST when Confirm is double-clicked and keeps the acks while starting (qa M3)', async () => {
    const required = [{ kind: 'npmRemoval', token: 't1', expiresAt: Date.now() + 60_000, textEn: 'e', textAr: 'ع', facts: {} }];
    let release: (value: Response) => void = () => {};
    let posts = 0;
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (init?.method !== 'POST') return response(job({ provider: 'claude' }));
      posts += 1;
      if (posts === 1) return response({ code: 'CONFIRMATION_REQUIRED', message: 'confirm', required }, 409);
      return new Promise<Response>((resolve) => { release = resolve; });
    });
    const { result } = renderHook(() => useHarnessInstall('claude'));
    await act(async () => result.current.start());
    const acks = [{ kind: 'npmRemoval' as const, token: 't1' }];
    let first: Promise<void> = Promise.resolve();
    act(() => { first = result.current.start(acks); void result.current.start(acks); });
    expect(posts).toBe(2);
    expect(result.current.state.status).toBe('starting');
    expect(result.current.state.required).toEqual(required);
    await act(async () => { release({ ok: true, status: 202, json: async () => ({ jobId: 'job-1' }) } as Response); await first; });
    await waitFor(() => expect(result.current.state.status).toBe('running'));
    expect(posts).toBe(2);
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
