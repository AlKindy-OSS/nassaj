/**
 * useLocalOverlay — the caller's own local model servers for the picker of a
 * coding agent that runs on them, Claude or Codex (ADR-227 Decision 10, T-2107).
 * The server answers an empty list while that agent's local switch is off or the
 * caller runs under a credential grant on it, and never sends an address, base URL
 * or key. A failed read degrades to "no local block".
 */
import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LocalBody, LocalOverlayServer } from '../view/subcomponents/localOverlayRows';

type OverlayResponse = { success?: boolean; data?: unknown };

/** Keeps only well-formed rows; anything else is dropped, never guessed. */
export function parseLocalOverlay(body: OverlayResponse | null | undefined): LocalOverlayServer[] {
  if (!body?.success || !Array.isArray(body.data)) return [];
  return body.data.filter((server): server is LocalOverlayServer => (
    typeof server?.providerId === 'string'
    && typeof server?.label === 'string'
    && Array.isArray(server?.models)
    && server.models.every((model: unknown) => (
      typeof (model as LocalOverlayServer['models'][number])?.value === 'string'
      && typeof (model as LocalOverlayServer['models'][number])?.eligibility === 'string'
      && Number.isSafeInteger((model as LocalOverlayServer['models'][number])?.minContextWindow)
    ))
  ));
}

/**
 * Reads `body`'s overlay when `enabled`; null until the first answer. Re-read on
 * each enable so a server edited in settings shows up the next time the picker
 * opens. Callers enable it only while the body × local matrix cell is open.
 */
export function useLocalOverlay(body: LocalBody, enabled: boolean): LocalOverlayServer[] | null {
  // null = not read yet: a surface must not call a server "deleted" before it knows.
  // Kept with the body it was read for, so one body never shows another's servers.
  const [read, setRead] = useState<{ body: LocalBody; rows: LocalOverlayServer[] } | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${body}/local-overlay`);
        const json = response.ok ? ((await response.json()) as OverlayResponse) : null;
        if (!cancelled) setRead({ body, rows: parseLocalOverlay(json) });
      } catch {
        if (!cancelled) setRead({ body, rows: [] });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [body, enabled]);

  return read?.body === body ? read.rows : null;
}
