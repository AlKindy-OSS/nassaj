import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';

/**
 * Shape of `GET /api/user/agy-connection`.
 *
 * `connected` reflects whether the *current* user has a usable Antigravity
 * (agy) credential in their isolated directory. The owner is symbolically
 * linked automatically, so the endpoint reports `connected: true` without any
 * onboarding on their part.
 */
export type AgyConnectionStatus = {
  connected: boolean;
  provider: 'agy';
};

type UseAgyConnectionResult = {
  connected: boolean;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
};

/**
 * Loads the per-user Antigravity (agy) subscription link status.
 *
 * Pure read hook (mirror of `useClaudeConnection`): it owns no business logic
 * beyond the fetch + normalisation. `enabled` lets the caller defer the request
 * until the section is mounted. `refresh` is re-exposed so the onboarding flow
 * can re-check status right after the user completes the interactive `agy`
 * login in the terminal.
 */
export function useAgyConnection(enabled = true): UseAgyConnectionResult {
  const [connected, setConnected] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.user.agyConnection();
      if (!res.ok) {
        setError('failed');
        return;
      }
      const payload = (await res.json()) as Partial<AgyConnectionStatus> | null;
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
