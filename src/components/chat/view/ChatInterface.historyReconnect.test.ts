import { readFileSync } from 'node:fs';

import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { canAutomaticallyReadHistory, historyRetryDelay, type HistoryError, type HistoryFailure } from '../../../stores/useSessionStore';
import { clearOutbox, getOutboxSnapshot, hasOutboxDeliveryEvidence, recordOutboxEntry,
  setOutboxUser, verifyOutboxReceipt } from '../utils/messageOutbox';

// Exercise the actual callback with controlled dependencies; this is not an app-boot test.
function callbackSource(name = 'handleWebSocketReconnect') {
  const source = ts.createSourceFile('ChatInterface.tsx', readFileSync('src/components/chat/view/ChatInterface.tsx', 'utf8'), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let callback: ts.Node | undefined;
  const visit = (node: ts.Node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText(source) === name
      && node.initializer && ts.isCallExpression(node.initializer)) callback = node.initializer.arguments[0];
    ts.forEachChild(node, visit);
  };
  visit(source);
  if (!callback) throw new Error('Reconnect callback not found');
  return ts.transpileModule(`(${callback.getText(source)})`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
}
function mount(failure: HistoryFailure) {
  const controllerRef = { current: null as AbortController | null };
  const sessionRef = { current: 's1' };
  const merge = vi.fn(async () => false);
  const clear = vi.fn();
  const deps = {
    selectedProject: { projectId: 'p1' }, selectedSession: { id: 's1', __provider: 'claude' },
    reconnectInFlightRef: { current: false }, reconnectControllerRef: controllerRef, reconnectSessionRef: sessionRef,
    historyRetryDelay, canAutomaticallyReadHistory, sendMessage: vi.fn(), bumpSessionActivityEpoch: vi.fn(),
    sessionStore: { mergeTailFromServer: merge, getLastSeq: () => 0, getSessionSlot: () => ({ historyError: merge.mock.calls.length ? failure : null }) },
    probeSessionActivity: vi.fn(async () => 'idle'), shouldClearLoadingAfterRecovery: () => true,
    setIsLoading: clear, setCanAbortSession: clear,
    // T-1660: the reconnect callback now also nudges the sticky-banner recovery
    // loop (useHistoryAutoRetry). It is a free variable of the extracted source,
    // so the eval harness must provide it; a no-op spy keeps these assertions
    // (which are about mergeTailFromServer + timers) unaffected.
    recoverHistoryNow: vi.fn(),
  };
  const handler = new Function(...Object.keys(deps), `return ${callbackSource()}`)(...Object.values(deps));
  return { handler, merge, clear, controllerRef, sessionRef };
}
beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());
describe('actual reconnect callback bounded history recovery', () => {
  it.each([[413, 'HISTORY_BUDGET_EXCEEDED'], [409, 'HISTORY_SOURCE_INCOMPLETE'], [409, 'HISTORY_REVISION_CHANGED']])(
    'never automatically retries %i %s', async (status, code) => {
      const { handler, merge } = mount({ ok: false, status: Number(status), code: String(code), retryAfterMs: null });
      await handler();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(merge).toHaveBeenCalledTimes(1);
    });
  it('waits the actual Retry-After once and does not create a retry loop', async () => {
    const { handler, merge } = mount({ ok: false, status: 503, code: 'HISTORY_BUSY', retryAfterMs: 8000 });
    const pending = handler();
    await vi.advanceTimersByTimeAsync(7999);
    expect(merge).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1);
    await pending;
    expect(merge).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(merge).toHaveBeenCalledTimes(2);
  });
  it('cancels a delayed timeout retry on navigation and does not clear the new view', async () => {
    const { handler, merge, clear, controllerRef, sessionRef } = mount({ ok: false, status: 504, code: 'HISTORY_TIMEOUT', retryAfterMs: null });
    const pending = handler();
    await vi.advanceTimersByTimeAsync(1);
    sessionRef.current = 's2';
    controllerRef.current?.abort();
    await pending;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(merge).toHaveBeenCalledTimes(1);
    expect(clear).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});


describe('actual delivery verification callback preserves independent receipt recovery', () => {
  const identity = { sessionId: 's1', clientMsgId: 'cmid_pending', provider: 'codex' };
  function delivery(error: HistoryError | null, accepted: boolean) {
    const refresh = vi.fn(async () => false);
    const fetchReceipt = vi.fn(async (_url: string, _options?: { signal?: AbortSignal }) => ({ ok: true, json: async () => accepted
      ? { ...identity, status: 'accepted', receipt: { ...identity, source: 'ingress_receipt', content: 'pending text', createdAt: '2026-09-07T00:00:00Z' } }
      : { status: 'unknown' } }));
    const deps = { canAutomaticallyReadHistory, hasOutboxDeliveryEvidence, verifyOutboxReceipt,
      authenticatedFetch: fetchReceipt, sessionStore: { refreshFromServer: refresh,
        getSessionSlot: () => ({ historyError: error, serverMessages: [] }) } };
    const verify = new Function(...Object.keys(deps), `return ${callbackSource('verifyMessageDelivered')}`)(...Object.values(deps));
    return { verify, refresh, fetchReceipt };
  }
  for (const accepted of [true, false]) {
    it.each([[413, 'HISTORY_BUDGET_EXCEEDED'], [409, 'HISTORY_SOURCE_INCOMPLETE'], [503, 'HISTORY_BUSY']])(
      `blocked history %i %s still checks receipt (accepted=${accepted}) without altering outbox`, async (status, code) => {
        clearOutbox(); setOutboxUser('c3-delivery-test');
        recordOutboxEntry({ id: identity.clientMsgId, sessionId: identity.sessionId, projectId: 'p1', text: 'pending text' });
        const held = getOutboxSnapshot();
        const { verify, refresh, fetchReceipt } = delivery({ ok: false, status: Number(status), code: String(code),
          retryAfterMs: status === 503 ? 5000 : null, retryAt: Date.now() + 5000, operation: 'initial' }, accepted);
        try {
          expect(await verify(identity.sessionId, identity.clientMsgId, identity.provider)).toBe(accepted ? 'accepted' : 'unknown');
          expect(refresh).not.toHaveBeenCalled();
          expect(fetchReceipt).toHaveBeenCalledTimes(1);
          expect(fetchReceipt.mock.calls[0][0]).toContain('/message-delivery/');
          expect(getOutboxSnapshot()).toBe(held);
          expect(held[0].status).toBe('pending');
        } finally { clearOutbox(); }
      });
  }
  it('allows history after Retry-After while still checking the independent receipt', async () => {
    const { verify, refresh, fetchReceipt } = delivery({ ok: false, status: 503, code: 'HISTORY_BUSY',
      retryAfterMs: 1000, retryAt: Date.now() - 1, operation: 'initial' }, false);
    expect(await verify(identity.sessionId, identity.clientMsgId, identity.provider)).toBe('unknown');
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(fetchReceipt).toHaveBeenCalledTimes(1);
  });
});
