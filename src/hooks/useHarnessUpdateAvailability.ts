import { useEffect, useState } from 'react';

import type { HarnessVersionStatus as WireStatus } from '../../shared/harness-update.contract';
import { authenticatedFetch } from '../utils/api';

import { mapVersionStatus } from './harnessVersionMapping';

/**
 * Harness ids (wire `provider`) that currently have a newer version than the
 * installed one. Reads the aggregate `GET /api/providers/version-status` once
 * per `refreshKey` change, so the selector tiles and the «التحديث» tab share a
 * single request instead of one probe per harness. A failed or unknown read
 * yields an empty set: the indicator is shown only on positive evidence.
 */
export function useHarnessUpdateAvailability(refreshKey: unknown): ReadonlySet<string> {
  const [available, setAvailable] = useState<ReadonlySet<string>>(() => new Set());

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      try {
        const response = await authenticatedFetch('/api/providers/version-status');
        if (!response.ok) return;
        const rows = await response.json() as WireStatus[];
        if (cancelled || !Array.isArray(rows)) return;
        setAvailable(new Set(rows
          .filter((row) => mapVersionStatus(row).status === 'update-available')
          .map((row) => row.provider)));
      } catch {
        // Unknown stays "no indicator"; the update panel reports the failure itself.
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [refreshKey]);

  return available;
}
