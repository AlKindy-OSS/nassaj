import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ authenticatedFetch: fetchMock }));
vi.mock('../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ latestMessage: null }) }));
vi.mock('./useRawExecConfig', () => ({ refreshRawExecConfig: vi.fn() }));

import { useServerActions } from './useServerActions';
import { useServerActionCatalog } from './useServerActionCatalog';

afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe('POST outcome evidence', () => {
  it.each([['queue', 'network'], ['catalog', 'network'], ['queue', 'proxy'], ['catalog', 'proxy']])('keeps a lost %s %s response unverified and issues no repeat POST', async (kind, failure) => {
    fetchMock.mockImplementation(async (_url: string, opts?: RequestInit) => {
      if (opts?.method === 'POST') {
        if (failure === 'network') throw new TypeError('connection lost');
        return { ok: false, json: async () => ({}) };
      }
      return { ok: true, json: async () => ({ actions: [] }) };
    });
    const hook = renderHook(() => {
      const queue = useServerActions(false);
      const catalog = useServerActionCatalog();
      return kind === 'queue' ? queue.execute : catalog.runAction;
    });
    let outcome: unknown;
    await act(async () => { outcome = await hook.result.current('safe-restart'); });
    expect(outcome).toEqual({ status: 'error', code: 'outcome_unverified' });
    expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
  });

  it('retains durable reasons and executing rows returned by the server', async () => {
    const actions = [{ id: 'a', status: 'executing', reasonCode: 'execution_unresolved', retryable: false }];
    fetchMock.mockResolvedValue({ ok: true, json: async () => ({ actions }) });
    const hook = renderHook(() => useServerActions(false));
    await waitFor(() => expect(hook.result.current.actions).toEqual(actions));
  });
});

it.each(['executing', 'unresolved', 'nonretryable'])('prioritizes %s over pending rows across remount without POST', async (kind) => {
  const actions = [
    { id: 'pending', actionType: 'safe-restart', status: 'pending' },
    { id: 'blocked', actionType: 'safe-restart', status: kind === 'executing' ? 'executing' : 'failed',
      ...(kind === 'unresolved' ? { reasonCode: 'execution_unresolved' } : {}),
      ...(kind === 'nonretryable' ? { retryable: false } : {}) },
  ];
  fetchMock.mockResolvedValue({ ok: true, json: async () => ({ actions }) });
  const first = renderHook(() => useServerActionCatalog());
  const expected = kind === 'executing' ? 'executing' : 'execution_unresolved';
  await waitFor(() => expect(first.result.current.liveStatusOf('safe-restart')).toBe(expected));
  first.unmount();
  // An unavailable refresh must preserve the known durable lock.
  fetchMock.mockRejectedValue(new TypeError('GET unavailable'));
  const second = renderHook(() => useServerActionCatalog());
  expect(second.result.current.liveStatusOf('safe-restart')).toBe(expected);
  await act(async () => { await second.result.current.runAction('safe-restart'); });
  expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(0);
});


it.each(['unknown_candidate', 'sensitive_candidate'])('keeps explicit %s refusal in queue state when refresh fails', async (code) => {
  const row = { id: 'restart', actionType: 'safe-restart', status: 'pending', error: null };
  fetchMock.mockResolvedValueOnce({ ok: true, json: async () => ({ actions: [row] }) });
  const hook = renderHook(() => useServerActions(false));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  fetchMock.mockResolvedValueOnce({ ok: false, json: async () => ({ code }) });
  await act(async () => { await hook.result.current.execute(row.id); });
  fetchMock.mockRejectedValueOnce(new Error('GET unavailable'));
  await act(async () => { await hook.result.current.refetch(); });
  expect(hook.result.current.actions[0]).toMatchObject({ status: 'failed', error: code, reasonCode: code });
});
