import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const fetchMock = vi.hoisted(() => vi.fn());
vi.mock('../utils/api', () => ({ authenticatedFetch: fetchMock }));
vi.mock('../contexts/WebSocketContext', () => ({ useWebSocket: () => ({ latestMessage: null }) }));
vi.mock('./useRawExecConfig', () => ({ refreshRawExecConfig: vi.fn() }));

import { useServerActions } from './useServerActions';
const row = { id: 'a', actionType: 'safe-restart', label: 'Restart', status: 'pending' };
const response = (body: unknown) => ({ ok: true, json: async () => body });
const dto = (status: string, actionId = 'a') => ({ actionId, currentActionOutcome: { status, reasonCode: status === 'success' ? 'oid_loaded' : status, retryable: status === 'pending' } });
afterEach(() => { cleanup(); sessionStorage.clear(); vi.resetAllMocks(); });

it.each(['success', 'failure', 'unknown', 'pending', 'mismatch'])('reconciles %s after a lost POST and reconnect without executing twice', async status => {
  let visible = true;
  let outcome = dto('pending');
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') { visible = false; throw new TypeError('offline'); }
    return response(url.endsWith('/outcome') ? outcome : { actions: visible ? [row] : [] });
  });
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  await act(async () => { await hook.result.current.execute('a'); });
  outcome = dto(status === 'mismatch' ? 'success' : status, status === 'mismatch' ? 'other' : 'a');
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(hook.result.current.actions[0].currentActionOutcome?.status).toBe(status === 'mismatch' ? 'unknown' : status));
  expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
});

it('restores an unknown reference after reload and requires fresh server proof', async () => {
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/outcome') ? dto('success') : { actions: [row] }));
  const first = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(first.result.current.actions[0]?.currentActionOutcome?.status).toBe('success'));
  first.unmount();
  fetchMock.mockRejectedValue(new TypeError('offline'));
  const second = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(second.result.current.actions[0]?.currentActionOutcome?.status).toBe('unknown'));
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/outcome') ? dto('success') : { actions: [] }));
  await act(async () => { await second.result.current.refetch(); });
  expect(second.result.current.actions[0].currentActionOutcome?.status).toBe('success');
});

it('discards late proof when the account changes', async () => {
  let resolve!: (value: unknown) => void;
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome')
    ? new Promise(done => { resolve = done; }) : response({ actions: [row] }));
  const hook = renderHook(({ scope }) => useServerActions(false, scope), { initialProps: { scope: 'owner' } });
  await waitFor(() => expect(resolve).toBeTypeOf('function'));
  fetchMock.mockResolvedValue(response({ actions: [] }));
  hook.rerender({ scope: 'different-owner' });
  await act(async () => { resolve(response(dto('success'))); });
  await waitFor(() => expect(hook.result.current.actions).toEqual([]));
});

it.each([401, 403, 404, 500])('does not infer success from an absent row or outcome HTTP %s', async status => {
  let visible = true;
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome')
    ? { ok: false, status, json: async () => dto('success') } : response({ actions: visible ? [row] : [] }));
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  visible = false;
  await act(async () => { await hook.result.current.refetch(); });
  expect(hook.result.current.actions[0].currentActionOutcome?.status).toBe('unknown');
  expect(hook.result.current.actions[0].retryable).toBe(false);
});

it('does not request owner-only outcomes for a non-owner', async () => {
  fetchMock.mockResolvedValue(response({ actions: [row] }));
  const hook = renderHook(() => useServerActions(false));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  expect(fetchMock.mock.calls.some(([url]) => url.endsWith('/outcome'))).toBe(false);
});

it('keeps a fresh legacy-server pending row executable but locks a lost attempt across reload', async () => {
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') throw new TypeError('response lost');
    return url.endsWith('/outcome') ? { ok: false, status: 404 } : response({ actions: [{ ...row, retryable: true }] });
  });
  const first = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(first.result.current.actions[0]?.retryable).toBe(true));
  expect(first.result.current.actions[0].currentActionOutcome).toBeUndefined();
  await act(async () => { await first.result.current.execute('a'); });
  await waitFor(() => expect(first.result.current.actions[0]?.currentActionOutcome?.status).toBe('unknown'));
  expect(first.result.current.actions[0].retryable).toBe(false);
  first.unmount();
  const second = renderHook(() => useServerActions(false, 'owner'));
  await act(async () => { await second.result.current.refetch(); });
  expect(second.result.current.actions[0].retryable).toBe(false);
  expect(second.result.current.actions[0].currentActionOutcome?.status).toBe('unknown');
  expect(fetchMock.mock.calls.filter(([, opts]) => opts?.method === 'POST')).toHaveLength(1);
});

it('releases a restored, never-attempted row when the legacy SPA fallback returns HTML', async () => {
  sessionStorage.setItem('server-action-outcomes:owner', JSON.stringify([row]));
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome')
    ? {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }
    : response({ actions: [{ ...row, retryable: true }] }));

  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions[0]).toMatchObject({
    id: row.id,
    status: 'pending',
    retryable: true,
  }));
  expect(hook.result.current.actions[0].currentActionOutcome).toBeUndefined();
  expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
});

it('keeps an attempted row locked when the legacy SPA fallback returns HTML', async () => {
  sessionStorage.setItem('server-action-outcomes:owner', JSON.stringify([{ ...row, attemptedLocally: true }]));
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome')
    ? {
      ok: true,
      status: 200,
      headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
      json: async () => { throw new SyntaxError('Unexpected token <'); },
    }
    : response({ actions: [{ ...row, retryable: true }] }));

  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions[0]).toMatchObject({
    attemptedLocally: true,
    retryable: false,
    currentActionOutcome: { status: 'unknown' },
  }));
  expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
});

it.each(['malformed-json', 'durable-unknown', 'transport', '503-html', 'html-prefix'])('keeps a fresh row locked when outcome evidence is %s', async kind => {
  fetchMock.mockImplementation(async (url: string) => {
    if (!url.endsWith('/outcome')) return response({ actions: [{ ...row, retryable: true }] });
    if (kind === 'transport') throw new TypeError('offline');
    if (kind === '503-html') {
      return {
        ok: false,
        status: 503,
        headers: new Headers({ 'content-type': 'text/html; charset=utf-8' }),
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      };
    }
    if (kind === 'html-prefix') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'text/htmlfoo; charset=utf-8' }),
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      };
    }
    if (kind === 'malformed-json') {
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'application/json' }),
        json: async () => { throw new SyntaxError('Unexpected token <'); },
      };
    }
    return response(dto('unknown'));
  });

  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions[0]).toMatchObject({
    retryable: false,
    currentActionOutcome: { status: 'unknown' },
  }));
  expect(fetchMock.mock.calls.some(([, opts]) => opts?.method === 'POST')).toBe(false);
});

it('preserves the in-memory attempt lock when browser persistence fails', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('disabled'); });
  fetchMock.mockImplementation(async (url: string, opts?: RequestInit) => {
    if (opts?.method === 'POST') throw new TypeError('response lost');
    return url.endsWith('/outcome') ? { ok: false, status: 404 } : response({ actions: [{ ...row, retryable: true }] });
  });
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  await act(async () => { await hook.result.current.execute('a'); });
  await act(async () => { window.dispatchEvent(new Event('online')); });
  await waitFor(() => expect(hook.result.current.actions[0]?.retryable).toBe(false));
  expect(hook.result.current.actions[0].attemptedLocally).toBe(true);
  storage.mockRestore();
});

it.each(['unknown_candidate', 'sensitive_candidate'])('does not loosen legacy preparation refusal %s', async reasonCode => {
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome') ? { ok: false, status: 404 }
    : response({ actions: [{ ...row, reasonCode, retryable: false }] }));
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions).toHaveLength(1));
  expect(hook.result.current.actions[0]).toMatchObject({ reasonCode, retryable: false });
});

it('removes only the locally retained superseded reference and keeps it removed after reload', async () => {
  sessionStorage.setItem('server-action-outcomes:owner', JSON.stringify([row]));
  sessionStorage.setItem('server-action-outcomes:other', JSON.stringify([row]));
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/outcome')
    ? { actionId: 'a', currentActionOutcome: { status: 'failure', reasonCode: 'superseded', retryable: false } }
    : { actions: [] }));
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions[0]?.currentActionOutcome?.reasonCode).toBe('superseded'));
  expect(hook.result.current.actions[0].currentActionOutcome?.status).toBe('failure');
  const callsBeforeRemoval = fetchMock.mock.calls.length;
  await act(async () => { expect(await hook.result.current.dismiss('a')).toEqual({ status: 'dismissed', id: 'a' }); });
  expect(fetchMock.mock.calls).toHaveLength(callsBeforeRemoval);
  expect(hook.result.current.actions).toEqual([]);
  expect(JSON.parse(sessionStorage.getItem('server-action-outcomes:owner')!)).toEqual([]);
  expect(JSON.parse(sessionStorage.getItem('server-action-outcomes:other')!)).toEqual([row]);
  hook.unmount();
  const restored = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(restored.result.current.loading).toBe(false));
  expect(restored.result.current.actions).toEqual([]);
  expect(fetchMock.mock.calls.some(([, opts]) => ['DELETE', 'POST'].includes(opts?.method))).toBe(false);
});

it('requires fresh outcome proof before removal even when stored state says superseded', async () => {
  sessionStorage.setItem('server-action-outcomes:owner', JSON.stringify([{ ...row,
    currentActionOutcome: { status: 'failure', reasonCode: 'superseded', retryable: false } }]));
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome')
    ? { ok: false, status: 404 } : response({ actions: [] }));
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.loading).toBe(false));
  await act(async () => { expect(await hook.result.current.dismiss('a')).toEqual({ status: 'error' }); });
  expect(hook.result.current.actions[0].currentActionOutcome?.status).toBe('unknown');
  expect(fetchMock.mock.calls.some(([, opts]) => ['DELETE', 'POST'].includes(opts?.method))).toBe(false);
});

it('rejects a stale owner callback after switching accounts', async () => {
  sessionStorage.setItem('server-action-outcomes:owner', JSON.stringify([row]));
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/outcome')
    ? { actionId: 'a', currentActionOutcome: { status: 'failure', reasonCode: 'superseded', retryable: false } }
    : { actions: [] }));
  const hook = renderHook(({ scope }) => useServerActions(false, scope), { initialProps: { scope: 'owner' } });
  await waitFor(() => expect(hook.result.current.actions[0]?.currentActionOutcome?.reasonCode).toBe('superseded'));
  const staleDismiss = hook.result.current.dismiss;
  hook.rerender({ scope: 'other' });
  await act(async () => { expect(await staleDismiss('a')).toEqual({ status: 'error' }); });
  expect(JSON.parse(sessionStorage.getItem('server-action-outcomes:owner')!)).toHaveLength(1);
  expect(fetchMock.mock.calls.some(([, opts]) => ['DELETE', 'POST'].includes(opts?.method))).toBe(false);
});

it('does not restore a removed reference from an already running refresh', async () => {
  sessionStorage.setItem('server-action-outcomes:owner', JSON.stringify([row]));
  const superseded = { actionId: 'a', currentActionOutcome: { status: 'failure', reasonCode: 'superseded', retryable: false } };
  fetchMock.mockImplementation(async (url: string) => response(url.endsWith('/outcome') ? superseded : { actions: [] }));
  const hook = renderHook(() => useServerActions(false, 'owner'));
  await waitFor(() => expect(hook.result.current.actions[0]?.currentActionOutcome?.reasonCode).toBe('superseded'));
  let finish!: (value: unknown) => void;
  fetchMock.mockImplementation(async (url: string) => url.endsWith('/outcome')
    ? new Promise(resolve => { finish = resolve; }) : response({ actions: [] }));
  let pending!: Promise<void>;
  act(() => { pending = hook.result.current.refetch(); });
  await waitFor(() => expect(finish).toBeTypeOf('function'));
  await act(async () => { await hook.result.current.dismiss('a'); });
  await act(async () => { finish(response(superseded)); await pending; });
  expect(hook.result.current.actions).toEqual([]);
  expect(JSON.parse(sessionStorage.getItem('server-action-outcomes:owner')!)).toEqual([]);
});
