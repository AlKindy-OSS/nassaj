import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useMessageFork } from './useMessageFork';

afterEach(() => vi.useRealTimers());

function forkHarness(send = (_message: unknown): { ok: boolean; reason?: string } => ({ ok: true })) {
  const sendMessage = vi.fn(send);
  const onForked = vi.fn();
  const onError = vi.fn();
  const hook = renderHook(({ sessionId, latestMessage }) => useMessageFork({
    sessionId, latestMessage, sendMessage, onForked, onError,
  }), { initialProps: { sessionId: 'source', latestMessage: null as any } });
  return { ...hook, sendMessage, onForked, onError,
    request: () => sendMessage.mock.calls.at(-1)![0] as any };
}

describe('message fork failure and navigation boundaries', () => {
  it('does not send twice on repeated clicks while the first request is pending', () => {
    const h = forkHarness();
    act(() => { h.result.current.forkFromMessage('saved'); h.result.current.forkFromMessage('saved'); });
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });

  it('reports a disconnected transport without starting a timer or retrying', () => {
    vi.useFakeTimers();
    const h = forkHarness(() => ({ ok: false, reason: 'disconnected' }));
    act(() => h.result.current.forkFromMessage('saved'));
    act(() => vi.advanceTimersByTime(60_000));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith('disconnected');
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.result.current.isForking).toBe(false);
  });

  it('treats a thrown send as uncertain and never retries automatically', () => {
    const h = forkHarness(() => { throw new Error('socket failed during send'); });
    act(() => h.result.current.forkFromMessage('saved'));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith('outcome_unknown');
    expect(h.sendMessage).toHaveBeenCalledOnce();
    expect(h.result.current.isForking).toBe(false);
  });

  it('times out without resending, ignores late completion and requires a new click', () => {
    vi.useFakeTimers();
    const h = forkHarness();
    act(() => h.result.current.forkFromMessage('saved'));
    const first = h.request();
    act(() => vi.advanceTimersByTime(30_001));
    expect(h.onError).toHaveBeenCalledExactlyOnceWith('timeout');
    expect(h.sendMessage).toHaveBeenCalledOnce();
    act(() => h.rerender({ sessionId: 'source', latestMessage: {
      type: 'message-forked', requestId: first.requestId, forkedSessionId: 'late',
    } }));
    expect(h.onForked).not.toHaveBeenCalled();
    act(() => h.result.current.forkFromMessage('saved'));
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    expect(h.request().requestId).not.toBe(first.requestId);
  });

  it('ignores a late reply after switching sessions without blocking the new session', () => {
    const h = forkHarness();
    act(() => h.result.current.forkFromMessage('saved'));
    const first = h.request();
    act(() => h.rerender({ sessionId: 'different', latestMessage: null }));
    expect(h.result.current.isForking).toBe(false);
    act(() => h.result.current.forkFromMessage('different-saved'));
    const second = h.request();
    act(() => h.rerender({ sessionId: 'different', latestMessage: {
      type: 'message-forked', requestId: first.requestId, forkedSessionId: 'late',
    } }));
    expect(h.onForked).not.toHaveBeenCalled();
    expect(h.result.current.isForking).toBe(true);
    act(() => h.rerender({ sessionId: 'different', latestMessage: {
      type: 'message-forked', requestId: second.requestId, forkedSessionId: 'correct',
    } }));
    expect(h.onForked).toHaveBeenCalledExactlyOnceWith('correct');
  });

  it('retries registration using the same request and server-attested target only on a click', () => {
    const h = forkHarness();
    act(() => h.result.current.forkFromMessage('saved'));
    const first = h.request();
    act(() => h.rerender({ sessionId: 'source', latestMessage: {
      type: 'message-fork-error', requestId: first.requestId, code: 'registration_failed', forkedSessionId: 'known-target',
    } }));
    expect(h.sendMessage).toHaveBeenCalledOnce();
    act(() => h.result.current.forkFromMessage('saved'));
    expect(h.request()).toEqual({ ...first, retryRegistrationOnly: true, expectedForkedSessionId: 'known-target' });
    act(() => h.rerender({ sessionId: 'source', latestMessage: {
      type: 'message-fork-error', requestId: first.requestId, code: 'registration_evidence_expired',
    } }));
    expect(h.onError).toHaveBeenLastCalledWith('registration_evidence_expired', undefined);
    expect(h.sendMessage).toHaveBeenCalledTimes(2);
    act(() => h.result.current.forkFromMessage('saved'));
    expect(h.request()).toEqual({ ...first, retryRegistrationOnly: true, expectedForkedSessionId: 'known-target' });
  });

  it('never presents a registration-only retry without an attested target', () => {
    const h = forkHarness();
    act(() => h.result.current.forkFromMessage('saved'));
    act(() => h.rerender({ sessionId: 'source', latestMessage: {
      type: 'message-fork-error', requestId: h.request().requestId, code: 'registration_failed',
    } }));
    expect(h.onError).toHaveBeenLastCalledWith('outcome_unknown', undefined);
    expect(h.sendMessage).toHaveBeenCalledOnce();
  });
});

describe('useMessageFork', () => {
  it('sends the explicit transcript UUID, then navigates on its matching completion', () => {
    const sendMessage = vi.fn((_message: unknown) => ({ ok: true }));
    const onForked = vi.fn();
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ latestMessage }) => useMessageFork({
        sessionId: 'source-session', latestMessage, sendMessage, onForked, onError,
      }),
      { initialProps: { latestMessage: null as any } },
    );

    act(() => result.current.forkFromMessage('transcript-row-uuid'));
    expect(sendMessage).toHaveBeenCalledOnce();
    const request = sendMessage.mock.calls[0]?.[0] as {
      type: string; requestId: string; sessionId: string; upToMessageId: string;
    };
    expect(request).toMatchObject({
      type: 'message-fork',
      sessionId: 'source-session',
      upToMessageId: 'transcript-row-uuid',
    });
    expect(typeof request.requestId).toBe('string');

    act(() => rerender({ latestMessage: {
      type: 'message-forked', requestId: request.requestId, forkedSessionId: 'forked-session',
    } }));
    expect(onForked).toHaveBeenCalledWith('forked-session');
    expect(onError).not.toHaveBeenCalled();
    expect(result.current.isForking).toBe(false);
  });

  it('ignores another request and maps its own terminal error', () => {
    const sendMessage = vi.fn((_message: unknown) => ({ ok: true }));
    const onForked = vi.fn();
    const onError = vi.fn();
    const { result, rerender } = renderHook(
      ({ latestMessage }) => useMessageFork({
        sessionId: 'source-session', latestMessage, sendMessage, onForked, onError,
      }),
      { initialProps: { latestMessage: null as any } },
    );

    act(() => result.current.forkFromMessage('transcript-row-uuid'));
    const requestId = (sendMessage.mock.calls[0]?.[0] as { requestId: string }).requestId;
    act(() => rerender({ latestMessage: { type: 'message-fork-error', requestId: 'other', code: 'busy' } }));
    expect(result.current.isForking).toBe(true);
    expect(onError).not.toHaveBeenCalled();

    act(() => rerender({ latestMessage: {
      type: 'message-fork-error', requestId, code: 'message_not_found', message: 'not shown',
    } }));
    expect(onError).toHaveBeenCalledWith('message_not_found', 'not shown');
    expect(onForked).not.toHaveBeenCalled();
    expect(result.current.isForking).toBe(false);
  });
});
