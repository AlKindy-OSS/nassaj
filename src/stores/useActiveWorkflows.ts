import { useCallback, useEffect, useRef } from 'react';

import { api } from '../utils/api';
import { normalizeWorkflowsEnvelope } from './workflowStatus';
import { setActiveWorkflows } from './workflowStatusStore';

/**
 * Driver hook for the honest background-workflow surface (B-103). Mounted ONCE
 * (in AppContent) behind the login gate, it keeps the global workflowStatusStore
 * fresh by polling GET /api/providers/workflows/active, then any badge subscribes
 * to the store per session/project without prop drilling.
 *
 * Fetch cadence (M4 — the only non-cloned piece):
 *   - Hydrate immediately on mount once `enabled` (auth-ready) is true.
 *   - Coalesced refetch: `scheduleRefetch()` (fed by AppContent's single existing
 *     latestMessage listener — NO new WS listener, T-234 debt) fires one fetch a
 *     tail-debounce (~1.5s) after the last call, folding message bursts into one.
 *   - Bounded poll (~8s) as a backstop, which:
 *       · stops while the tab is hidden (document.hidden) and resumes on return;
 *       · QUIESCES after an envelope with zero workflows AND not capped — there
 *         is nothing to watch and the scan was complete, so we stop the timer
 *         until a transition (visibility return or a refetch signal) wakes it;
 *       · keeps ticking while any workflow is active OR the scan was capped
 *         (an unscanned orphan might exist — never silently stop looking).
 *   - Single-flight: one request at a time (`inFlight`); a poll and a signal can
 *     never overlap. A signal that lands mid-flight is remembered and honoured
 *     as soon as the in-flight request settles.
 *
 * StrictMode-safe: all liveness flags are effect-scoped locals (not refs), so a
 * mount → cleanup → remount cannot leak a second loop or re-arm a dead timer.
 * Read-only: it only ever GETs; it never mutates a workflow.
 */

export const WORKFLOW_POLL_INTERVAL_MS = 8000;
export const WORKFLOW_REFETCH_DEBOUNCE_MS = 1500;

export function useActiveWorkflows(enabled: boolean): { scheduleRefetch: () => void } {
  // Holds the live effect's debounced trigger so the returned callback identity
  // is stable while always pointing at the current mount (or a no-op when off).
  const triggerRef = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    let stopped = false;
    let inFlight = false;
    let quiet = false; // last envelope was empty & not capped → poll paused
    let pendingWake = false; // a wake arrived mid-flight → honour it on settle
    let pollTimer: ReturnType<typeof setTimeout> | null = null;
    let debounceTimer: ReturnType<typeof setTimeout> | null = null;
    const controller = new AbortController();

    const clearPollTimer = () => {
      if (pollTimer) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
    };

    const schedulePoll = () => {
      clearPollTimer();
      // Do not spin while unmounted, quiescent, or hidden — a transition resumes.
      if (stopped || quiet || document.hidden) {
        return;
      }
      pollTimer = setTimeout(() => {
        void fetchNow();
      }, WORKFLOW_POLL_INTERVAL_MS);
    };

    const fetchNow = async () => {
      if (stopped || inFlight) {
        return;
      }
      if (document.hidden) {
        return; // stay parked; visibilitychange wakes us
      }
      inFlight = true;
      try {
        const res = await api.providers.activeWorkflows({ signal: controller.signal });
        if (stopped) {
          return;
        }
        if (res.ok) {
          const safe = normalizeWorkflowsEnvelope(await res.json());
          if (stopped) {
            return;
          }
          setActiveWorkflows(safe);
          // Quiesce only when there is genuinely nothing to watch AND the scan
          // was complete. If capped, an unscanned orphan might exist → keep polling.
          quiet = safe.workflows.length === 0 && !safe.capped;
        }
        // Non-ok (auth/5xx): leave the store as-is and keep the normal cadence.
      } catch {
        // Network hiccup or abort-on-unmount: keep the last store, reschedule.
      } finally {
        inFlight = false;
      }

      // Honour a wake that arrived while this request was in flight.
      if (!stopped && pendingWake) {
        pendingWake = false;
        if (!document.hidden) {
          void fetchNow();
          return;
        }
      }
      schedulePoll();
    };

    const wake = () => {
      // Any transition (visibility return or a coalesced refetch signal) unpauses
      // and refetches immediately, subject to single-flight.
      quiet = false;
      if (inFlight) {
        pendingWake = true;
        return;
      }
      if (!document.hidden) {
        void fetchNow();
      }
    };

    const onVisibility = () => {
      if (!document.hidden) {
        wake();
      }
    };

    const triggerDebounced = () => {
      if (stopped) {
        return;
      }
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      debounceTimer = setTimeout(() => {
        debounceTimer = null;
        wake();
      }, WORKFLOW_REFETCH_DEBOUNCE_MS);
    };
    triggerRef.current = triggerDebounced;

    // Hydrate on mount + auth-ready.
    void fetchNow();
    document.addEventListener('visibilitychange', onVisibility);

    return () => {
      stopped = true;
      controller.abort();
      clearPollTimer();
      if (debounceTimer) {
        clearTimeout(debounceTimer);
      }
      document.removeEventListener('visibilitychange', onVisibility);
      triggerRef.current = () => {};
    };
  }, [enabled]);

  const scheduleRefetch = useCallback(() => {
    triggerRef.current();
  }, []);

  return { scheduleRefetch };
}
