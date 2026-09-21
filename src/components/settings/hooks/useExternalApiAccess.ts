/**
 * Hook for the programmatic-access master switch (ADR-102 / T-1242).
 *
 * `POST /api/agent` is disabled by default; this reads and flips the app-wide
 * flag that opens it. The write is owner-only — `canManage` mirrors what the
 * server will accept so the control can render read-only instead of failing on
 * click, but the server's `requireRole('owner')` is what actually enforces it.
 */
import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

type ExternalApiState = {
  enabled: boolean;
  canManage: boolean;
};

type ExternalApiResponse = Partial<ExternalApiState> & { error?: string };

export function useExternalApiAccess() {
  const [enabled, setEnabled] = useState(false);
  const [canManage, setCanManage] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchState = useCallback(async () => {
    try {
      setLoading(true);
      const response = await authenticatedFetch('/api/settings/external-api');
      const payload = await response.json() as ExternalApiResponse;
      // Unreadable state is treated as OFF, matching the server's fail-closed
      // read — the UI must never imply the surface is open when it is not.
      setEnabled(payload.enabled === true);
      setCanManage(payload.canManage === true);
    } catch (fetchError) {
      console.error('Error fetching programmatic access state:', fetchError);
      setEnabled(false);
      setCanManage(false);
    } finally {
      setLoading(false);
    }
  }, []);

  const setExternalApiEnabled = useCallback(async (next: boolean) => {
    setSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch('/api/settings/external-api', {
        method: 'PUT',
        body: JSON.stringify({ enabled: next }),
      });
      const payload = await response.json() as ExternalApiResponse;

      if (!response.ok) {
        setError(payload.error || 'Failed to update programmatic access');
        return;
      }

      setEnabled(payload.enabled === true);
    } catch (saveError) {
      console.error('Error updating programmatic access state:', saveError);
      setError('Failed to update programmatic access');
    } finally {
      setSaving(false);
    }
  }, []);

  useEffect(() => {
    void fetchState();
  }, [fetchState]);

  return { enabled, canManage, loading, saving, error, setExternalApiEnabled };
}
