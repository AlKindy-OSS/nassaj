/**
 * useClaudeLocalOverlay — the caller's own local model servers for the Claude
 * picker (ADR-227 Decision 10). The server answers an empty list while the local
 * switch is off or the caller runs under a credential grant, and never sends an
 * address, base URL or key. A failed read degrades to "no local block".
 */
import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LocalOverlayServer } from '../view/subcomponents/localOverlayRows';

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
    ))
  ));
}

/**
 * Reads the overlay when `enabled` (Claude body shown); null until the first
 * answer. Re-read on each enable so a server edited in settings shows up the
 * next time the picker opens.
 */
export function useClaudeLocalOverlay(enabled: boolean): LocalOverlayServer[] | null {
  // null = not read yet: a surface must not call a server "deleted" before it knows.
  const [overlay, setOverlay] = useState<LocalOverlayServer[] | null>(null);

  useEffect(() => {
    if (!enabled) return undefined;
    let cancelled = false;
    void (async () => {
      try {
        const response = await authenticatedFetch('/api/providers/claude/local-overlay');
        const body = response.ok ? ((await response.json()) as OverlayResponse) : null;
        if (!cancelled) setOverlay(parseLocalOverlay(body));
      } catch {
        if (!cancelled) setOverlay([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  return overlay;
}
