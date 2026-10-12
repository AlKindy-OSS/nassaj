import { useCallback, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

import { NETWORK_FAILURE, readApiFailure, type ApiFailure } from './vendorKeyApi';

/**
 * `POST /api/providers/vendor-keys/backups/:harness/restore` (ADR-200 §3).
 * `keys` (default) puts back only the API-key fields; `full` puts the file back
 * byte for byte and the server wants `confirm: true`. The result lists what a
 * restore left alone (`skipped`), never a key value.
 */

export type BackupHarness = 'claude' | 'codex' | 'opencode';

export type RestoreMode = 'keys' | 'full';

export type RestoreSkip = { target: string; outcome: 'login_present' };

export type RestoreOutcome =
  | { restored: true; skipped: RestoreSkip[] }
  | { restored: false; failure: ApiFailure };

type RestoreResponse = {
  data?: { skipped?: RestoreSkip[] };
};

export function useVendorBackups() {
  const [busy, setBusy] = useState<BackupHarness | null>(null);

  const restore = useCallback(async (harness: BackupHarness, mode: RestoreMode): Promise<RestoreOutcome> => {
    setBusy(harness);
    try {
      const response = await authenticatedFetch(
        `/api/providers/vendor-keys/backups/${encodeURIComponent(harness)}/restore`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(mode === 'full' ? { mode: 'full', confirm: true } : {}),
        },
      );
      if (!response.ok) {
        return { restored: false, failure: await readApiFailure(response, 'Restore failed') };
      }
      const payload = (await response.json()) as RestoreResponse;
      return { restored: true, skipped: payload.data?.skipped ?? [] };
    } catch {
      return { restored: false, failure: NETWORK_FAILURE };
    } finally {
      setBusy(null);
    }
  }, []);

  return { busy, restore };
}
