import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { type HistoryError } from '../../../stores/useSessionStore';

import { useHistoryAutoRetry } from './useHistoryAutoRetry';

const err = (status: number, retryAt = 0): HistoryError => ({
  ok: false, status, code: null, retryAfterMs: null, operation: 'initial', retryAt,
});

function setup(initial: {
  sessionId?: string; historyError: HistoryError | null;
  slotError?: HistoryError | null;
}) {
  const retryHistory = vi.fn();
  // recoverHistoryNow reads the live slot error; default it to the prop.
  const readHistoryError = vi.fn(() => initial.slotError ?? initial.historyError);
  const view = renderHook(
    (props: { sessionId: string | undefined; historyError: HistoryError | null }) =>
      useHistoryAutoRetry({ ...props, retryHistory, readHistoryError }),
    { initialProps: { sessionId: initial.sessionId ?? 's1', historyError: initial.historyError } },
  );
  return { retryHistory, readHistoryError, ...view };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { vi.runOnlyPendingTimers(); vi.useRealTimers(); cleanup(); });

describe('useHistoryAutoRetry', () => {
  it.each([0, 502, 530])('auto-recovers after a transient status %i on backoff', (status) => {
    const { retryHistory } = setup({ historyError: err(status) });
    expect(retryHistory).not.toHaveBeenCalled();
    act(() => { vi.advanceTimersByTime(1000); });
    expect(retryHistory).toHaveBeenCalledTimes(1);
  });

  it('does not auto-retry a non-retryable 404 or 413', () => {
    const four04 = setup({ historyError: err(404) });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(four04.retryHistory).not.toHaveBeenCalled();
    cleanup();
    const four13 = setup({ historyError: err(413) });
    act(() => { vi.advanceTimersByTime(60_000); });
    expect(four13.retryHistory).not.toHaveBeenCalled();
  });

  it('stops after the backoff cap (5 attempts), each on a fresh failure', () => {
    const { retryHistory, rerender } = setup({ historyError: err(0) });
    // Each failed retry sets a NEW error object; advance long enough to clear
    // any backoff step (max 16s), then hand the hook the next failure.
    for (let i = 0; i < 8; i += 1) {
      act(() => { vi.advanceTimersByTime(30_000); });
      act(() => { rerender({ sessionId: 's1', historyError: err(0) }); });
    }
    expect(retryHistory).toHaveBeenCalledTimes(5);
  });

  it('cancels a pending timer when the session switches', () => {
    const { retryHistory, rerender } = setup({ historyError: err(0) });
    act(() => { vi.advanceTimersByTime(500); });
    // Switch to a session with no error before the 1000ms timer fires.
    act(() => { rerender({ sessionId: 's2', historyError: null }); });
    act(() => { vi.advanceTimersByTime(5000); });
    expect(retryHistory).not.toHaveBeenCalled();
  });

  it('reads immediately on `online` and does not also fire the pending timer', () => {
    const { retryHistory } = setup({ historyError: err(0) });
    act(() => { vi.advanceTimersByTime(500); });
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(retryHistory).toHaveBeenCalledTimes(1);
    // The pending backoff timer must have been cleared — no duplicate read.
    act(() => { vi.advanceTimersByTime(5000); });
    expect(retryHistory).toHaveBeenCalledTimes(1);
  });

  it('reads immediately when the tab becomes visible', () => {
    const { retryHistory } = setup({ historyError: err(0) });
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    expect(retryHistory).toHaveBeenCalledTimes(1);
  });

  it('does not recover on a network signal when the error is non-retryable', () => {
    const { retryHistory } = setup({ historyError: err(404) });
    act(() => { window.dispatchEvent(new Event('online')); });
    expect(retryHistory).not.toHaveBeenCalled();
  });
});
