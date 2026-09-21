import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';
import type { ClaudeUsage, ClaudeUsageState } from '../claudeUsageTypes';

// Backend caches usage for 180s; mirror that as the client refresh interval so
// an open panel stays fresh without hammering the endpoint.
const REFRESH_INTERVAL_MS = 180_000;

type UseClaudeUsageResult = ClaudeUsageState & {
  refetch: () => void;
};

/**
 * Fetches Claude account usage while `enabled` is true (i.e. the panel is open),
 * then refreshes every 180s. Data fetching only — no presentation concerns here.
 */
export function useClaudeUsage(enabled: boolean): UseClaudeUsageResult {
  const [state, setState] = useState<ClaudeUsageState>({ status: 'idle' });
  // Track the latest in-flight request so stale responses are ignored.
  const requestIdRef = useRef(0);

  const fetchUsage = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setState((prev) =>
      prev.status === 'success' ? prev : { status: 'loading' },
    );

    try {
      const response = await api.providers.claudeUsage();
      if (requestId !== requestIdRef.current) return;

      if (!response.ok) {
        let code: string | null = null;
        try {
          const body = await response.json();
          code = body?.code ?? null;
        } catch {
          // Non-JSON error body — fall back to a generic error.
        }
        setState({ status: 'error', code });
        return;
      }

      const data = (await response.json()) as ClaudeUsage;
      if (requestId !== requestIdRef.current) return;
      setState({ status: 'success', data });
    } catch {
      if (requestId !== requestIdRef.current) return;
      setState({ status: 'error', code: null });
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    fetchUsage();
    const intervalId = window.setInterval(fetchUsage, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [enabled, fetchUsage]);

  return { ...state, refetch: fetchUsage };
}
