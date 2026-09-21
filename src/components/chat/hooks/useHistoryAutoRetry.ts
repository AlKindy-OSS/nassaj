import { useCallback, useEffect, useRef } from 'react';

import {
  historyRetryDelay,
  planHistoryAutoRetry,
  type HistoryError,
} from '../../../stores/useSessionStore';

/**
 * T-1660: automatic recovery for a sticky "unavailable" history banner.
 *
 * A history read that fails during a restart/drain (transport status 0, or a
 * Cloudflare-tunnel origin 5xx like 520–524/530) leaves `historyError` set, but
 * nothing was scheduling a follow-up read — auto-reads only fired on WS
 * reconnect or a session switch — so the banner stuck until the user pressed
 * "Try again". This hook retries the failed operation on capped exponential
 * backoff, and immediately on the three "the network is probably back now"
 * signals: WS reconnect (via the returned `recoverHistoryNow`), the `online`
 * event, and the tab regaining visibility.
 *
 * It only decides WHEN to read. `retryHistory` owns the per-operation recovery
 * path (initial/older/all/deferred/reconnect), preserves displayed and pending
 * rows, and self-dedupes concurrent reads through its own loading guards and
 * AbortController — so this hook never issues a duplicate in-flight request.
 * A non-retryable failure (4xx: 400/401/404/413) is left alone, keeping only
 * the manual button; once the backoff cap is reached, recovery stops until a
 * fresh network signal resets the budget.
 */
export function useHistoryAutoRetry(params: {
  sessionId: string | undefined;
  historyError: HistoryError | null | undefined;
  retryHistory: () => void | Promise<void>;
  readHistoryError: (sessionId: string) => HistoryError | null | undefined;
}): { recoverHistoryNow: () => void } {
  const { sessionId, historyError, retryHistory, readHistoryError } = params;
  const attemptsRef = useRef(0);
  const timerRef = useRef<number | null>(null);

  const clearTimer = useCallback(() => {
    if (timerRef.current !== null) {
      window.clearTimeout(timerRef.current);
      timerRef.current = null;
    }
  }, []);

  // A fresh network signal resets the backoff budget and reads at once; a
  // non-retryable or already-clear error is left untouched.
  const recoverHistoryNow = useCallback(() => {
    const failure = sessionId ? readHistoryError(sessionId) : null;
    if (!failure || historyRetryDelay(failure) === null) return;
    attemptsRef.current = 0;
    clearTimer();
    void retryHistory();
  }, [sessionId, readHistoryError, retryHistory, clearTimer]);

  // A new session's banner must start with a full recovery budget, not inherit
  // the previous session's spent attempts or its pending timer.
  useEffect(() => {
    attemptsRef.current = 0;
    clearTimer();
  }, [sessionId, clearTimer]);

  // Backoff scheduler: (re)arms whenever the active session's historyError
  // changes. Success clears historyError (this effect re-runs and drops the
  // timer); each failed retry sets a new error and bumps the attempt count
  // until the cap, after which only the manual button remains.
  useEffect(() => {
    clearTimer();
    if (!historyError) { attemptsRef.current = 0; return; }
    const plan = planHistoryAutoRetry(historyError, attemptsRef.current);
    if (!plan.retry) return;
    timerRef.current = window.setTimeout(() => {
      timerRef.current = null;
      attemptsRef.current += 1;
      void retryHistory();
    }, plan.delayMs);
    return clearTimer;
  }, [historyError, retryHistory, clearTimer]);

  // Network-return signals: read immediately instead of waiting out the backoff.
  useEffect(() => {
    const onVisible = () => { if (document.visibilityState === 'visible') recoverHistoryNow(); };
    window.addEventListener('online', recoverHistoryNow);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('online', recoverHistoryNow);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [recoverHistoryNow]);

  return { recoverHistoryNow };
}
