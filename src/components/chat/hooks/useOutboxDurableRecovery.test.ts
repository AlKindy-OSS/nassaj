// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';

import { authenticatedFetch } from '../../../utils/api';
import * as outbox from '../utils/messageOutbox';

import { readBoundedOutboxHistory, recoverOutboxSession, useOutboxDurableRecovery, OUTBOX_RECOVERY_BODY_BYTES } from './useOutboxDurableRecovery';

vi.mock('../../../utils/api', () => ({ authenticatedFetch: vi.fn() }));
vi.mock('../utils/messageOutbox', () => ({
  getOutboxAccountEpoch: vi.fn(() => 1), getOutboxSnapshot: vi.fn(() => []),
  subscribeOutbox: vi.fn(() => () => undefined), reserveOutboxRecoveryAttempt: vi.fn(),
  hasCanonicalOutboxProof: vi.fn(), removeOutboxEntryWithProof: vi.fn(),
  canReconcileOutboxHistory: vi.fn(() => true),
}));
const entry = { id: 'one', projectId: 'project', sessionId: 'session', text: 'same', createdAt: 1, status: 'delivered', reasonCode: null, reasonDetail: null, imageNames: [], fileNames: [], fileCount: 0, intent: { provider: 'codex' } } as outbox.OutboxEntry;
function response(data: unknown, status = 200): Response {
  const bytes = new TextEncoder().encode(JSON.stringify(data));
  return { ok: status === 200, status, body: new ReadableStream({ start(c) { c.enqueue(bytes); c.close(); } }) } as unknown as Response;
}
async function settle<T>(promise: Promise<T>): Promise<T> {
  await vi.runAllTimersAsync();
  return promise;
}
beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); localStorage.clear();
  vi.mocked(outbox.reserveOutboxRecoveryAttempt).mockResolvedValue(true);
  vi.mocked(outbox.getOutboxSnapshot).mockReturnValue([entry]);
  vi.mocked(outbox.hasCanonicalOutboxProof).mockReturnValue(null);
  vi.mocked(outbox.canReconcileOutboxHistory).mockReturnValue(true);
  vi.mocked(outbox.getOutboxAccountEpoch).mockReturnValue(1);
});
afterEach(() => vi.useRealTimers());

describe('bounded full canonical reads', () => {
  it('rejects chunked oversized bodies before JSON parsing', async () => {
    const body = new ReadableStream({ start(c) { c.enqueue(new Uint8Array(OUTBOX_RECOVERY_BODY_BYTES + 1)); c.close(); } });
    await expect(readBoundedOutboxHistory({ body } as unknown as Response, new AbortController().signal)).rejects.toThrow('history_body_limit');
  });
  it('rejects light projection and more than twenty rows', async () => {
    await expect(readBoundedOutboxHistory(response({ messages: [], payloadMode: 'light' }), new AbortController().signal)).rejects.toThrow();
    await expect(readBoundedOutboxHistory(response({ messages: Array.from({ length: 21 }, () => ({ id: 'x', kind: 'text' })) }), new AbortController().signal)).rejects.toThrow();
  });
  it('does not read when persistent budget denies reservation', async () => {
    vi.mocked(outbox.reserveOutboxRecoveryAttempt).mockResolvedValue(false);
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => true));
    expect(authenticatedFetch).not.toHaveBeenCalled();
    expect(outbox.reserveOutboxRecoveryAttempt).toHaveBeenCalledWith(JSON.stringify(['owner', 'project', 'codex', 'session']));
  });
  it('includes delivered rows and budgets every cursor page without auth replay', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => response({ messages: [], hasMore: true, nextCursor: 'next', revision: 'r1' }));
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => true));
    expect(authenticatedFetch).toHaveBeenCalledTimes(5);
    expect(outbox.reserveOutboxRecoveryAttempt).toHaveBeenCalledTimes(5);
    expect(authenticatedFetch).toHaveBeenNthCalledWith(2, expect.stringContaining('cursor=next&revision=r1'), expect.objectContaining({ __isRetry: true }));
    expect(outbox.removeOutboxEntryWithProof).not.toHaveBeenCalled();
  });
  it.each([401, 403, 404, 409])('stops permanent/rebase HTTP %s without retry', async status => {
    vi.mocked(authenticatedFetch).mockResolvedValue(response({}, status));
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => true));
    expect(authenticatedFetch).toHaveBeenCalledTimes(1);
  });
  it('rejects a stale account result even when it contains canonical identity', async () => {
    let current = true;
    vi.mocked(authenticatedFetch).mockImplementation(async () => { current = false; return response({ messages: [] }); });
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => current));
    expect(outbox.hasCanonicalOutboxProof).not.toHaveBeenCalled();
  });
  it('does not mint proof for a payload replaced while history was in flight', async () => {
    vi.mocked(authenticatedFetch).mockImplementation(async () => {
      vi.mocked(outbox.getOutboxSnapshot).mockReturnValue([{ ...entry, text: 'replacement' }]);
      return response({ messages: [] });
    });
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => true));
    expect(outbox.hasCanonicalOutboxProof).not.toHaveBeenCalled();
    expect(outbox.removeOutboxEntryWithProof).not.toHaveBeenCalled();
  });
  it('routes canonical deletion through the guarded typed proof only', async () => {
    const proof = { account: 'owner', epoch: 1, id: 'one', generation: 'g', sessionId: 'session', projectId: 'project', provider: 'codex', coverage: 'text' as const };
    vi.mocked(outbox.hasCanonicalOutboxProof).mockReturnValue(proof);
    vi.mocked(outbox.removeOutboxEntryWithProof).mockImplementation(async () => { vi.mocked(outbox.getOutboxSnapshot).mockReturnValue([]); return true; });
    vi.mocked(authenticatedFetch).mockResolvedValue(response({ messages: [] }));
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => true));
    expect(outbox.removeOutboxEntryWithProof).toHaveBeenCalledExactlyOnceWith(entry, proof);
  });
  it('bounds stalled requests by deadline', async () => {
    vi.mocked(authenticatedFetch).mockImplementation((_url, opts) => new Promise((_resolve, reject) => {
      const signal = opts?.signal;
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    await settle(recoverOutboxSession([entry], 'owner', new AbortController().signal, () => true));
    expect(authenticatedFetch).toHaveBeenCalledTimes(5);
  });
});

describe('authenticated app lifetime', () => {
  beforeEach(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: vi.fn(async (_key, _options, callback) => callback(null)) } });
  });
  it('does no background work in hidden/offline tabs or rollback mode', () => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    const hook = renderHook(() => useOutboxDurableRecovery('owner'));
    expect(navigator.locks.request).not.toHaveBeenCalled(); hook.unmount();
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    const offline = renderHook(() => useOutboxDurableRecovery('owner')); offline.unmount();
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
    localStorage.setItem('nassaj_ob2_automatic_recovery', 'disabled');
    const paused = renderHook(() => useOutboxDurableRecovery('owner')); paused.unmount();
    expect(navigator.locks.request).not.toHaveBeenCalled();
  });
  it('aborts an active request when hidden or when the authenticated account changes', async () => {
    vi.mocked(navigator.locks.request).mockImplementation(async (_name, _options, callback) => callback({ name: 'recovery', mode: 'exclusive' }));
    let activeSignal: AbortSignal | undefined;
    vi.mocked(authenticatedFetch).mockImplementation((_url, options) => new Promise((_resolve, reject) => {
      const signal = options?.signal ?? undefined;
      activeSignal = signal;
      signal?.addEventListener('abort', () => reject(new Error('aborted')));
    }));
    const hook = renderHook(({ account }) => useOutboxDurableRecovery(account), { initialProps: { account: 'owner' } });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    expect(activeSignal?.aborted).toBe(false);
    await act(async () => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
      document.dispatchEvent(new Event('visibilitychange'));
      await Promise.resolve();
    });
    expect(activeSignal?.aborted).toBe(true);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    hook.rerender({ account: 'second' });
    await act(async () => { await vi.advanceTimersByTimeAsync(1); });
    const secondSignal = activeSignal;
    hook.unmount();
    expect(secondSignal?.aborted).toBe(true);
    expect(outbox.removeOutboxEntryWithProof).not.toHaveBeenCalled();
  });
  it('examines sessions across the account without a selected-chat dependency', async () => {
    vi.mocked(navigator.locks.request).mockImplementation(async (_name, _options, callback) => callback({ name: 'recovery', mode: 'exclusive' }));
    vi.mocked(outbox.getOutboxSnapshot).mockReturnValue([entry, { ...entry, id: 'two', sessionId: 'another' }]);
    vi.mocked(authenticatedFetch).mockImplementation(async () => response({}, 404));
    const hook = renderHook(() => useOutboxDurableRecovery('owner'));
    await act(async () => { await vi.advanceTimersByTimeAsync(10); });
    expect(authenticatedFetch).toHaveBeenCalledTimes(2);
    expect(authenticatedFetch).toHaveBeenCalledWith(expect.stringContaining('/another/messages?'), expect.any(Object));
    hook.unmount();
  });
  it('uses one origin lock with ifAvailable and releases subscriptions', async () => {
    const unsub = vi.fn(); vi.mocked(outbox.subscribeOutbox).mockReturnValue(unsub);
    const hook = renderHook(() => useOutboxDurableRecovery('owner'));
    await act(async () => { await Promise.resolve(); });
    expect(navigator.locks.request).toHaveBeenCalledWith('nassaj-outbox-v2-recovery', { ifAvailable: true }, expect.any(Function));
    hook.unmount(); expect(unsub).toHaveBeenCalledOnce();
  });
});
