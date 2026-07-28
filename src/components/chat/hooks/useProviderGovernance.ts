import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

export type GovernanceStatus = 'governed' | 'ungoverned';
export type GovernanceMechanism =
  | 'codex-fingerprint'
  | 'claude-md'
  | 'opencode-agents'
  | 'none';

export type GovernanceDescriptor = {
  provider: string;
  status: GovernanceStatus;
  enforced: boolean;
  mechanism: GovernanceMechanism;
};

type GovernanceResponse = {
  success?: boolean;
  data?: {
    provider?: string;
    status?: string;
    enforced?: unknown;
    mechanism?: string;
  };
};

/**
 * Live governance descriptor for a provider session
 * (`GET /api/providers/:provider/governance`, T-900/§المرحلة 3).
 *
 * Fail-HIDDEN: any network error, 404 (old server without the route), or
 * unrecognised payload resolves to `null` — the GovernanceBadge disappears
 * silently. This is the honest contract: absence of data = "unknown", never
 * "ungoverned". A hidden badge is safer than a lying one.
 *
 * Keyed by `[provider]` so it re-fetches only when the active session's
 * provider changes (MVP cadence — no WS live-push yet, T-900 §4).
 */
export function useProviderGovernance(
  provider: LLMProvider | undefined | null,
): GovernanceDescriptor | null {
  const [descriptor, setDescriptor] = useState<GovernanceDescriptor | null>(null);

  useEffect(() => {
    if (!provider) {
      setDescriptor(null);
      return;
    }

    let cancelled = false;
    setDescriptor(null);

    (async () => {
      try {
        const response = await authenticatedFetch(`/api/providers/${provider}/governance`);
        if (!response.ok) {
          // 404 = old server without the endpoint; any non-2xx = transient error.
          // Both cases: hide silently — no console output, no error state.
          if (!cancelled) setDescriptor(null);
          return;
        }
        const payload = (await response.json()) as GovernanceResponse;
        if (cancelled) return;

        const data = payload.data;
        const status = data?.status;
        const enforced = data?.enforced;
        const mechanism = data?.mechanism;

        if (
          (status === 'governed' || status === 'ungoverned') &&
          typeof enforced === 'boolean' &&
          typeof mechanism === 'string'
        ) {
          setDescriptor({
            provider: data?.provider ?? provider,
            status,
            enforced,
            mechanism: mechanism as GovernanceMechanism,
          });
        } else {
          // Unrecognised payload shape → hide silently.
          setDescriptor(null);
        }
      } catch {
        // Network-level error → hide silently, no console.error.
        if (!cancelled) setDescriptor(null);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [provider]);

  return descriptor;
}
