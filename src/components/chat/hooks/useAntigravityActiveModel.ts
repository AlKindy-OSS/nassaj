import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../../../utils/api';

// agy refreshes its active model on its own cadence; a light client interval
// keeps the read-only display reasonably fresh while a provider screen is open.
const REFRESH_INTERVAL_MS = 60_000;

interface AntigravityActiveModelResponse {
  label: string | null;
  fetchedAt: string;
}

export interface UseAntigravityActiveModelResult {
  /** Human-readable active model label, or null when agy reports none. */
  label: string | null;
  loading: boolean;
  error: boolean;
  refetch: () => void;
}

/**
 * Fetches the read-only active model for the Antigravity (agy) provider from
 * `GET /api/providers/antigravity/active-model` while `enabled` is true, then
 * refreshes periodically. Data fetching only — no presentation concerns here.
 */
export function useAntigravityActiveModel(enabled: boolean): UseAntigravityActiveModelResult {
  const [label, setLabel] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  // Track the latest in-flight request so stale responses are ignored.
  const requestIdRef = useRef(0);

  const fetchActiveModel = useCallback(async () => {
    const requestId = ++requestIdRef.current;
    setLoading(true);
    setError(false);

    try {
      const response = await api.providers.antigravityActiveModel();
      if (requestId !== requestIdRef.current) return;

      if (!response.ok) {
        setError(true);
        setLoading(false);
        return;
      }

      const data = (await response.json()) as AntigravityActiveModelResponse;
      if (requestId !== requestIdRef.current) return;

      setLabel(data?.label ?? null);
      setLoading(false);
    } catch {
      if (requestId !== requestIdRef.current) return;
      setError(true);
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!enabled) return undefined;

    fetchActiveModel();
    const intervalId = window.setInterval(fetchActiveModel, REFRESH_INTERVAL_MS);
    return () => window.clearInterval(intervalId);
  }, [enabled, fetchActiveModel]);

  return { label, loading, error, refetch: fetchActiveModel };
}
