import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

import { NETWORK_FAILURE, readApiFailure, type ApiFailure } from './vendorKeyApi';

/**
 * Drives the ONE-KEY-PER-VENDOR surface (T-1159, ADR-200 S9):
 *
 *   GET    /api/providers/company/:companyId/key
 *            -> per-slot state, plus (flag ON) `projections` and `migrationConflict`
 *   POST   /api/providers/company/:companyId/key -> { apiKey, replaceForeignKey?, consent? }
 *   DELETE /api/providers/company/:companyId/key[?removeForeignKey=true]
 *   POST   /api/providers/company/:companyId/key/conflict -> { harness, target }
 *
 * The vendor owns ONE key and nassaj fans it out to the harnesses it feeds, so
 * the client no longer names slots: Save and Delete carry no `vendorIds`, and a
 * stale client that still narrows a delete is refused by the server with
 * 409 `VENDOR_DELETE_IS_VENDOR_WIDE`.
 *
 * Results stay per slot rather than a boolean. A fan-out can legitimately
 * half-apply — a harness on a subscription keeps it, a login is never
 * overwritten, a foreign key is left untouched until confirmed — and a surface
 * that collapsed that into "Saved" would lie in exactly the cases that matter.
 */

/** What happened to one slot during a Save or a Delete. Mirrors the server union. */
export type CompanySlotOutcome =
  | 'written' | 'skipped_subscription' | 'forbidden' | 'failed'
  | 'linked' | 'kept_on_subscription' | 'mode_unset' | 'login_present'
  | 'shared_scope_refused' | 'foreign_credential'
  | 'removed' | 'absent' | 'adopted_credential';

export type CompanySlotResult = {
  vendorId: string;
  provider: string;
  target?: string;
  outcome: CompanySlotOutcome;
  error?: string;
  code?: string;
};

export type CompanySlotStatus = {
  vendorId: string;
  provider: string;
  target?: string;
  configured: boolean;
  /** True when that harness is currently signed in by subscription. */
  subscription: boolean;
  /** A stored profile the simplified single-key flow cannot use (T-1906). */
  status?: 'incompatible_profile';
};

/** Ledger state of one projection (flag ON, `GET` only). */
export type ProjectionState =
  | 'linked' | 'stale' | 'failed' | 'tombstone' | 'adopted' | 'foreign_credential'
  | 'kept_on_subscription' | 'login_present' | 'shared_scope_refused' | 'mode_unset';

export type CompanyProjection = {
  vendorId: string;
  provider: string;
  target?: string;
  state: ProjectionState;
};

/** D9: where the conflicting keys sit. `group` equal = same key; `null` = not usable. */
export type ConflictSource = { harness: string; target: string | null; group: number | null };

export type MigrationConflict = { sources: ConflictSource[] };

type MutationResult =
  | { success: true; slots: CompanySlotResult[] }
  | { success: false; failure: ApiFailure };

type CompanyKeyResponse = {
  data?: {
    configured?: boolean;
    writable?: boolean;
    slots?: (CompanySlotResult & CompanySlotStatus)[];
    projections?: CompanyProjection[];
    migrationConflict?: MigrationConflict;
  };
};

export type SaveOptions = {
  /** Explicit consent for companies whose disclosure must be accepted (Alibaba). */
  consent?: boolean;
  /** Confirmed replacement of a key nassaj did not write. */
  replaceForeignKey?: boolean;
};

export function useCompanyKey(companyId: string) {
  const [slots, setSlots] = useState<CompanySlotStatus[]>([]);
  const [projections, setProjections] = useState<CompanyProjection[] | null>(null);
  const [migrationConflict, setMigrationConflict] = useState<MigrationConflict | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  /**
   * `undefined` = unanswered, or a server that predates these routes. Silence
   * degrades to the permissive behaviour and lets the server's own 403 speak,
   * never locks the surface (B-367).
   */
  const [writable, setWritable] = useState<boolean | undefined>(undefined);

  const endpoint = `/api/providers/company/${encodeURIComponent(companyId)}/key`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch(endpoint);
      if (!response.ok) {
        // A server without these routes answers 404: "no company surface here".
        setSlots([]);
        return;
      }
      const data = ((await response.json()) as CompanyKeyResponse).data;
      setSlots((data?.slots ?? []) as CompanySlotStatus[]);
      setProjections(Array.isArray(data?.projections) ? data.projections : null);
      setMigrationConflict(data?.migrationConflict ?? null);
      setWritable(data?.writable);
    } catch {
      setFailure(NETWORK_FAILURE);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** One mutation: busy flag, failure capture, refetch on success. */
  const mutate = useCallback(async (
    request: () => Promise<Response>,
    fallback: string,
  ): Promise<MutationResult> => {
    setSaving(true);
    setFailure(null);
    try {
      const response = await request();
      if (!response.ok) {
        const next = await readApiFailure(response, fallback);
        setFailure(next);
        return { success: false, failure: next };
      }
      const payload = (await response.json()) as CompanyKeyResponse;
      await refresh();
      return { success: true, slots: (payload.data?.slots ?? []) as CompanySlotResult[] };
    } catch {
      setFailure(NETWORK_FAILURE);
      return { success: false, failure: NETWORK_FAILURE };
    } finally {
      setSaving(false);
    }
  }, [refresh]);

  const saveKey = useCallback((apiKey: string, options: SaveOptions = {}) => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      const empty: ApiFailure = { status: 400, code: 'API_KEY_REQUIRED', message: 'API key is required', details: {} };
      setFailure(empty);
      return Promise.resolve<MutationResult>({ success: false, failure: empty });
    }
    // No `vendorIds`: the vendor is the unit, the fan-out decides the places.
    // Flags are omitted, not sent `false`, when the caller has nothing to say.
    return mutate(() => authenticatedFetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        apiKey: trimmed,
        ...(options.consent === true ? { consent: true } : {}),
        ...(options.replaceForeignKey === true ? { replaceForeignKey: true } : {}),
      }),
    }), 'Failed to save the key');
  }, [endpoint, mutate]);

  /** Vendor-wide delete; `removeForeignKey` is the confirmed removal of keys nassaj did not write. */
  const deleteKey = useCallback((removeForeignKey = false) => mutate(
    () => authenticatedFetch(
      removeForeignKey ? `${endpoint}?removeForeignKey=true` : endpoint,
      { method: 'DELETE' },
    ),
    'Failed to remove the key',
  ), [endpoint, mutate]);

  /** D9: keeps the key held at `source`; a vanished conflict refetches silently. */
  const resolveConflict = useCallback(async (source: { harness: string; target: string | null }) => {
    const result = await mutate(() => authenticatedFetch(`${endpoint}/conflict`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ harness: source.harness, target: source.target }),
    }), 'Failed to choose the key');
    if (!result.success && result.failure.code === 'VENDOR_MIGRATION_NO_CONFLICT') {
      await refresh();
      setFailure(null);
    }
    return result;
  }, [endpoint, mutate, refresh]);

  const clearFailure = useCallback(() => setFailure(null), []);

  /** True when any slot of this vendor currently holds the key. */
  const configured = slots.some((slot) => slot.configured);

  return {
    slots, projections, migrationConflict, configured, loading, saving, failure, writable,
    refresh, saveKey, deleteKey, resolveConflict, clearFailure,
  };
}
