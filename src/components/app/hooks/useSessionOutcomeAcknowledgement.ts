import { useCallback, useEffect, useRef } from 'react';

import {
  acknowledgeOutcomeWhenActive,
  getOutcomeAcknowledgementToken,
  refreshOutcomes,
  releaseManualUnread,
} from '../../../stores/sessionCompletionStore';
import { pageIsActive } from '../../../utils/pageActivity';

export type DocumentNavigationType = PerformanceNavigationTiming['type'] | 'unknown';

const OUTCOME_REFRESH_RETRY_DELAYS_MS = [250, 500, 1_000, 2_000, 5_000] as const;

type UseSessionOutcomeAcknowledgementArgs = {
  routeSessionId: string | null;
  routeLocationKey: string;
  selectedSessionId: string | null;
  isConnected: boolean;
  initialNavigationType?: DocumentNavigationType;
};

/** Read once by the policy hook. Unknown is handled fail-closed as restoration. */
export function readDocumentNavigationType(
  browserPerformance: Pick<Performance, 'getEntriesByType'> | null =
    typeof performance === 'undefined' ? null : performance,
): DocumentNavigationType {
  try {
    const entry = browserPerformance?.getEntriesByType('navigation')[0] as
      | PerformanceNavigationTiming
      | undefined;
    return entry?.type ?? 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Central read-intent policy for terminal conversation outcomes (B-753).
 *
 * A proven initial navigation/back-forward and every router location after
 * mount is an opening. Reload and unknown initial navigation restore UI state,
 * so neither may clear an indicator. Location keys intentionally distinguish
 * a later navigation to the same session.
 */
export function useSessionOutcomeAcknowledgement({
  routeSessionId,
  routeLocationKey,
  selectedSessionId,
  isConnected,
  initialNavigationType = readDocumentNavigationType(),
}: UseSessionOutcomeAcknowledgementArgs): void {
  const selectedSessionIdRef = useRef<string | null>(selectedSessionId);
  const lastRouteFingerprintRef = useRef<string | null>(null);
  const initialNavigationTypeRef = useRef(initialNavigationType);
  const snapshotReadyRef = useRef(false);
  const pendingOpenedSessionIdsRef = useRef(new Set<string>());
  const hydratedOpenedSessionIdsRef = useRef(new Set<string>());
  const deferredAcknowledgementTokensRef = useRef(new Map<string, string>());
  selectedSessionIdRef.current = selectedSessionId;

  const flushPendingOpenedSessions = useCallback(() => {
    if (!snapshotReadyRef.current) return;
    for (const sessionId of hydratedOpenedSessionIdsRef.current) {
      const token = getOutcomeAcknowledgementToken(sessionId);
      hydratedOpenedSessionIdsRef.current.delete(sessionId);
      pendingOpenedSessionIdsRef.current.delete(sessionId);
      if (!token) continue;
      if (pageIsActive()) {
        acknowledgeOutcomeWhenActive(sessionId, true);
      } else {
        deferredAcknowledgementTokensRef.current.set(sessionId, token);
      }
    }
  }, []);

  const registerRouteOpening = useCallback((sessionId: string) => {
    // A route abandoned before its session hydrated was never actually opened.
    for (const pendingSessionId of pendingOpenedSessionIdsRef.current) {
      if (
        pendingSessionId !== sessionId
        && !hydratedOpenedSessionIdsRef.current.has(pendingSessionId)
      ) {
        pendingOpenedSessionIdsRef.current.delete(pendingSessionId);
      }
    }
    pendingOpenedSessionIdsRef.current.add(sessionId);
    if (selectedSessionIdRef.current === sessionId) {
      hydratedOpenedSessionIdsRef.current.add(sessionId);
    }
    flushPendingOpenedSessions();
  }, [flushPendingOpenedSessions]);

  useEffect(() => {
    // Snapshot readiness belongs to this connection epoch. Never acknowledge
    // against a pre-disconnect mirror while a reconnect snapshot is pending.
    snapshotReadyRef.current = false;
    if (!isConnected) return;
    let cancelled = false;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;

    const attemptRefresh = (attempt: number) => {
      void refreshOutcomes().then((applied) => {
        if (cancelled) return;
        if (applied) {
          snapshotReadyRef.current = true;
          flushPendingOpenedSessions();
          return;
        }
        const delay = OUTCOME_REFRESH_RETRY_DELAYS_MS[
          Math.min(attempt, OUTCOME_REFRESH_RETRY_DELAYS_MS.length - 1)
        ];
        retryTimer = setTimeout(() => attemptRefresh(attempt + 1), delay);
      });
    };

    attemptRefresh(0);
    return () => {
      cancelled = true;
      if (retryTimer) clearTimeout(retryTimer);
      snapshotReadyRef.current = false;
    };
  }, [flushPendingOpenedSessions, isConnected]);

  useEffect(() => {
    const fingerprint = `${routeLocationKey}\u0000${routeSessionId ?? ''}`;
    if (lastRouteFingerprintRef.current === fingerprint) return;
    const initialRoute = lastRouteFingerprintRef.current === null;
    // Record before the reload exemption: StrictMode replays this effect and
    // must see the same initial location as already handled, not as a new open.
    lastRouteFingerprintRef.current = fingerprint;
    if (!routeSessionId) {
      for (const pendingSessionId of pendingOpenedSessionIdsRef.current) {
        if (!hydratedOpenedSessionIdsRef.current.has(pendingSessionId)) {
          pendingOpenedSessionIdsRef.current.delete(pendingSessionId);
        }
      }
      return;
    }
    if (
      initialRoute
      && (initialNavigationTypeRef.current === 'reload'
        || initialNavigationTypeRef.current === 'unknown')
    ) return;
    registerRouteOpening(routeSessionId);
  }, [registerRouteOpening, routeLocationKey, routeSessionId]);

  useEffect(() => {
    releaseManualUnread(selectedSessionId);
    if (
      selectedSessionId
      && pendingOpenedSessionIdsRef.current.has(selectedSessionId)
    ) {
      hydratedOpenedSessionIdsRef.current.add(selectedSessionId);
      flushPendingOpenedSessions();
    }
  }, [flushPendingOpenedSessions, selectedSessionId]);

  useEffect(() => {
    const consumeOnReturn = () => {
      if (!pageIsActive()) return;
      flushPendingOpenedSessions();
      for (const [sessionId, token] of deferredAcknowledgementTokensRef.current) {
        acknowledgeOutcomeWhenActive(sessionId, true, token);
        deferredAcknowledgementTokensRef.current.delete(sessionId);
      }
    };
    document.addEventListener('visibilitychange', consumeOnReturn);
    window.addEventListener('focus', consumeOnReturn);
    return () => {
      document.removeEventListener('visibilitychange', consumeOnReturn);
      window.removeEventListener('focus', consumeOnReturn);
    };
  }, [flushPendingOpenedSessions]);
}
