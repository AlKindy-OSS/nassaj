import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const { authenticatedFetch } = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));
vi.mock('../utils/api', () => ({ authenticatedFetch }));
import { historyRetryDelay, useSessionStore, type NormalizedMessage } from './useSessionStore';
const row = (id: string): NormalizedMessage => ({ id, sessionId: 's1', kind: 'text', role: 'assistant',
  provider: 'claude', timestamp: '2026-09-07T00:00:00Z', content: id });
const ok = (id = 'held') => ({ ok: true, json: async () => ({ messages: [row(id)], total: 40, hasMore: true, nextCursor: 'cursor-a' }) });
const error = (status: number, code: string, retry?: string) => ({ ok: false, status,
  headers: new Headers(retry ? { 'Retry-After': retry } : {}), json: async () => ({ error: { code, message: '/private/path' } }) });
const failures = [[413, 'HISTORY_BUDGET_EXCEEDED'], [409, 'HISTORY_SOURCE_INCOMPLETE'],
  [409, 'HISTORY_REVISION_CHANGED'], [409, 'CURSOR_STALE'], [503, 'HISTORY_BUSY'], [504, 'HISTORY_TIMEOUT']] as const;
beforeEach(() => authenticatedFetch.mockReset());
afterEach(cleanup);
describe('C1 history failure contract', () => {
  it.each(failures)('preserves history, cursor and pending rows after %i %s for full/older/reconnect reads', async (status, code) => {
    const { result } = renderHook(() => useSessionStore());
    authenticatedFetch.mockResolvedValue(ok());
    await act(async () => { await result.current.fetchFromServer('s1', { limit: 20 }); });
    act(() => result.current.appendRealtime('s1', { ...row('pending'), role: 'user', clientMsgId: 'pending-client' }));
    const held = result.current.getSlot('s1');
    const messages = held.serverMessages, pending = held.realtimeMessages;
    authenticatedFetch.mockReset().mockResolvedValue(error(status, code, status === 503 ? '7' : undefined));
    await act(async () => {
      expect(await result.current.fetchMore('s1')).toMatchObject({ ok: false, status, code });
      expect(await result.current.fetchFromServer('s1', { limit: null })).toMatchObject({ ok: false, status, code });
      expect(await result.current.mergeTailFromServer('s1')).toBe(false);
    });
    expect(authenticatedFetch).toHaveBeenCalledTimes(3);
    expect(held.serverMessages).toBe(messages);
    expect(held.realtimeMessages).toBe(pending);
    expect(held).toMatchObject({ historyCursor: 'cursor-a', offset: 1, total: 40, hasMore: true,
      historyError: { code, status, retryAfterMs: status === 503 ? 7000 : null } });
    expect(JSON.stringify(held.historyError)).not.toContain('/private/path');
  });
  it.each([{}, { messages: null }, { messages: [], historySchema: 2 },
    { messages: [], payloadMode: 'chunk' }, { messages: [], historySchema: 1 }, { messages: [], total: -1 }, { messages: [{}] }])('rejects unsupported successful bodies: %j', async body => {
    authenticatedFetch.mockResolvedValue({ ok: true, json: async () => body });
    const { result } = renderHook(() => useSessionStore());
    let response;
    await act(async () => { response = await result.current.fetchFromServer('s1'); });
    expect(response).toMatchObject({ ok: false, code: 'HISTORY_UNSUPPORTED_RESPONSE' });
    expect(result.current.getSlot('s1').fetchedAt).toBe(0);
  });
  it('ignores an older same-session completion after a newer snapshot', async () => {
    let finish!: (response: ReturnType<typeof error>) => void;
    authenticatedFetch.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
    const { result } = renderHook(() => useSessionStore());
    let pending!: ReturnType<typeof result.current.fetchFromServer>;
    act(() => { pending = result.current.fetchFromServer('s1'); });
    authenticatedFetch.mockResolvedValue(ok('new'));
    await act(async () => { await result.current.fetchFromServer('s1'); });
    await act(async () => { finish(error(413, 'HISTORY_BUDGET_EXCEEDED')); await pending; });
    expect(result.current.getSlot('s1').serverMessages[0].id).toBe('new');
    expect(result.current.getSlot('s1').historyError).toBeNull();
  });
  it('aborted reads do not change held rows or produce an error', async () => {
    const controller = new AbortController();
    authenticatedFetch.mockImplementation(async () => { controller.abort(); return error(503, 'HISTORY_BUSY'); });
    const { result } = renderHook(() => useSessionStore());
    await act(async () => { expect(await result.current.fetchMore('s1', { signal: controller.signal })).toMatchObject({ ok: true }); });
    await act(async () => { expect(await result.current.fetchFromServer('s1', { signal: controller.signal })).toMatchObject({ ok: false, status: 499 }); });
    expect(result.current.getSlot('s1').historyError).toBeNull();
  });
  it('supports delta/date Retry-After and refuses permanent or excessive automatic delays', async () => {
    const { result } = renderHook(() => useSessionStore());
    authenticatedFetch.mockResolvedValue(error(503, 'HISTORY_BUSY', '8'));
    const response = await result.current.requestHistorySnapshot('s1');
    expect(response).toMatchObject({ retryAfterMs: 8000 });
    expect(!response.ok && historyRetryDelay(response)).toBe(8000);
    for (const [status, code] of failures.filter(([status]) => status < 500)) {
      expect(historyRetryDelay({ ok: false, status, code, retryAfterMs: null })).toBeNull();
    }
    expect(historyRetryDelay({ ok: false, status: 503, code: 'HISTORY_BUSY', retryAfterMs: 120_000 })).toBeNull();
    authenticatedFetch.mockResolvedValue(error(503, 'HISTORY_BUSY', new Date(Date.now() + 20_000).toUTCString()));
    const dated = await result.current.requestHistorySnapshot('s1');
    expect(!dated.ok && dated.retryAfterMs).toBeGreaterThan(18_000);
  });
  for (const method of ['refreshFromServer', 'mergeTailFromServer'] as const) {
    for (const newer of ['snapshot', 'failure'] as const) {
      it.each(['success', 'http-failure', 'rejection'] as const)(`${method}: late %s cannot overwrite a newer ${newer}`, async oldOutcome => {
        const { result } = renderHook(() => useSessionStore());
        authenticatedFetch.mockResolvedValue(ok('held'));
        await act(async () => { await result.current.fetchFromServer('s1'); });
        act(() => result.current.appendRealtime('s1', { ...row('cmid_pending'), role: 'user' }));
        let finish!: (value: ReturnType<typeof ok> | ReturnType<typeof error>) => void;
        let reject!: (reason: Error) => void;
        authenticatedFetch.mockImplementationOnce(() => new Promise((resolve, fail) => { finish = resolve; reject = fail; }));
        let pending!: Promise<boolean>;
        act(() => { pending = result.current[method]('s1'); });
        authenticatedFetch.mockResolvedValue(newer === 'snapshot' ? ok('rebased') : error(413, 'HISTORY_BUDGET_EXCEEDED'));
        await act(async () => { await result.current.fetchFromServer('s1', { limit: 20 }); });
        const slot = result.current.getSlot('s1');
        const messages = slot.serverMessages, heldError = slot.historyError, realtime = slot.realtimeMessages;
        await act(async () => {
          if (oldOutcome === 'rejection') reject(new Error('old transport reset'));
          else finish(oldOutcome === 'success' ? ok('old-tail') : error(503, 'HISTORY_BUSY'));
          expect(await pending).toBe(false);
        });
        expect(slot.serverMessages).toBe(messages);
        expect(slot.historyError).toBe(heldError);
        expect(slot.realtimeMessages).toBe(realtime);
        expect(slot.historyCursor).toBe('cursor-a');
        expect(slot.serverMessages[0].id).toBe(newer === 'snapshot' ? 'rebased' : 'held');
      });
    }
  }

});
