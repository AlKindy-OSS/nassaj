import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';

/**
 * Shape of `GET /api/user/claude-connection`.
 *
 * `connected` reflects whether the *current* user has a usable Claude
 * credential in their isolated directory. The owner is symbolically linked
 * automatically, so the endpoint reports `connected: true` without any
 * onboarding on their part.
 */
export type ClaudeConnectionStatus = {
  connected: boolean;
  provider: 'claude';
};

type UseClaudeConnectionResult = {
  connected: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Loads the per-user Claude subscription link status (B-MU-ONBOARD).
 *
 * Pure read hook: it owns no business logic beyond the fetch + normalisation.
 * `enabled` lets the caller defer the request until the section is mounted
 * (e.g. only when the settings tab is open). `refresh` is re-exposed so the
 * onboarding flow can re-check status right after the user completes
 * `claude setup-token` in the terminal.
 */
export function useClaudeConnection(enabled = true): UseClaudeConnectionResult {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.user.claudeConnection();
      if (!res.ok) {
        setError('failed');
        return;
      }
      const payload = (await res.json()) as Partial<ClaudeConnectionStatus> | null;
      setConnected(payload?.connected === true);
    } catch {
      setError('network');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  return { connected, loading, error, refresh };
}
