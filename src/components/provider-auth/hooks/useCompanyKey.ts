import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

/**
 * Drives the ONE-KEY-PER-COMPANY surface (T-1159):
 *
 *   GET    /api/providers/company/:companyId/key -> per-slot state (never the value)
 *   POST   /api/providers/company/:companyId/key -> { apiKey, vendorIds?, includeSubscription? }
 *   DELETE /api/providers/company/:companyId/key?vendorIds=a,b -> remove from those slots
 *
 * The company routes fan ONE paste out to the credential slots that company
 * owns, each written through its harness's own native surface.
 *
 * T-1201 — `vendorIds` carries the operator's TICKED slots, because the tab now
 * offers one field per company and a checkbox per place instead of one input
 * box per place. Omitting the field keeps the old "every slot" meaning, which
 * is what this hook does whenever the caller expressed no selection. The list
 * only ever narrows the server's own candidate set; it authorizes nothing.
 *
 * The result is deliberately per-slot rather than a boolean. A fan-out can
 * legitimately half-apply — a subscribed harness is skipped so its plan is not
 * downgraded, and a shared slot is refused for a member — and a surface that
 * collapsed that into "Saved" would be lying in exactly the cases that matter.
 */

/** What happened to one slot during the fan-out. Mirrors the server union. */
export type CompanySlotOutcome = 'written' | 'skipped_subscription' | 'forbidden' | 'failed';

export type CompanySlotResult = {
  vendorId: string;
  provider: string;
  target?: string;
  outcome: CompanySlotOutcome;
  error?: string;
};

export type CompanySlotStatus = {
  vendorId: string;
  provider: string;
  target?: string;
  configured: boolean;
  /** True when that harness is currently signed in by subscription. */
  subscription: boolean;
};

type MutationResult =
  | { success: true; slots: CompanySlotResult[] }
  | { success: false; error: string };

type CompanyKeyResponse = {
  data?: {
    companyId?: string;
    configured?: boolean;
    writable?: boolean;
    slots?: (CompanySlotResult & CompanySlotStatus)[];
  };
  error?: string;
  message?: string;
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as CompanyKeyResponse;
    return payload?.error ?? payload?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function useCompanyKey(companyId: string) {
  const [slots, setSlots] = useState<CompanySlotStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * `undefined` = unanswered, or a server that predates these routes. Same
   * B-367 rule as the per-slot hook: silence must degrade to the old permissive
   * behaviour and let the server's own 403 speak, never lock the surface.
   */
  const [writable, setWritable] = useState<boolean | undefined>(undefined);

  const endpoint = `/api/providers/company/${encodeURIComponent(companyId)}/key`;

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(endpoint);
      if (!response.ok) {
        // A server without these routes answers 404: that is "no company
        // surface here", not an error worth showing over the per-slot boxes.
        setSlots([]);
        return;
      }
      const payload = (await response.json()) as CompanyKeyResponse;
      setSlots((payload.data?.slots ?? []) as CompanySlotStatus[]);
      setWritable(payload.data?.writable);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(
    async (
      apiKey: string,
      options: { includeSubscription?: boolean; vendorIds?: string[] } = {},
    ): Promise<MutationResult> => {
      const trimmed = apiKey.trim();
      if (!trimmed) {
        const message = 'API key is required';
        setError(message);
        return { success: false, error: message };
      }

      setSaving(true);
      setError(null);
      try {
        const response = await authenticatedFetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          // `vendorIds` is OMITTED, not sent empty, when the caller expressed no
          // selection: an absent field is the server's "every slot", while an
          // empty array is an explicit 400. That distinction is what keeps a
          // client running against a server whose `GET` answered no slot list
          // (B-367 skew) from posting a selection it could not have made.
          body: JSON.stringify({
            apiKey: trimmed,
            includeSubscription: options.includeSubscription === true,
            ...(options.vendorIds ? { vendorIds: options.vendorIds } : {}),
          }),
        });
        if (!response.ok) {
          const message = await readError(response, 'Failed to save the key');
          setError(message);
          return { success: false, error: message };
        }
        const payload = (await response.json()) as CompanyKeyResponse;
        await refresh();
        return { success: true, slots: (payload.data?.slots ?? []) as CompanySlotResult[] };
      } catch {
        const message = 'Network error';
        setError(message);
        return { success: false, error: message };
      } finally {
        setSaving(false);
      }
    },
    [endpoint, refresh],
  );

  /**
   * Removes the key from `vendorIds`, or from every slot when none is named.
   *
   * The ids ride on the QUERY STRING rather than a DELETE body: a request body
   * on DELETE is legal but not carried by every proxy, and a dropped body here
   * would silently widen a one-slot removal into a whole-company wipe.
   */
  const deleteKey = useCallback(async (vendorIds?: string[]): Promise<MutationResult> => {
    setSaving(true);
    setError(null);
    try {
      const url = vendorIds?.length
        ? `${endpoint}?vendorIds=${encodeURIComponent(vendorIds.join(','))}`
        : endpoint;
      const response = await authenticatedFetch(url, { method: 'DELETE' });
      if (!response.ok) {
        const message = await readError(response, 'Failed to remove the key');
        setError(message);
        return { success: false, error: message };
      }
      const payload = (await response.json()) as CompanyKeyResponse;
      await refresh();
      return { success: true, slots: (payload.data?.slots ?? []) as CompanySlotResult[] };
    } catch {
      const message = 'Network error';
      setError(message);
      return { success: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [endpoint, refresh]);

  /** True when any slot of this company currently holds a key. */
  const configured = slots.some((slot) => slot.configured);

  return { slots, configured, loading, saving, error, writable, refresh, saveKey, deleteKey };
}
