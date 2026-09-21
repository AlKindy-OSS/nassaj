import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

export type GovernanceStatus = 'governed' | 'ungoverned';
export type GovernanceMechanism =
  | 'codex-fingerprint'
  | 'claude-md'
  | 'opencode-agents'
  | 'kimi-agents'
  | 'gemini-md'
  | 'nassaj-project-md'
  | 'none';

/** ADR-093 §2.1 — how a channel's verdict was reached. */
export type GovernanceVerification = 'fingerprint' | 'presence' | 'none';
/** ADR-093 §2.1 — three degrees, so "materialized but unguarded" ≠ "no channel". */
export type GovernanceEnforcement = 'fail-closed' | 'best-effort' | 'informational' | 'none';
export type GovernanceScope = 'user' | 'project';
/** ADR-093 §2.2 — WHY a channel is not governed (+ the declared project extension). */
export type GovernanceReason =
  | 'no_mechanism'
  | 'source_absent'
  | 'copy_missing'
  | 'copy_empty'
  | 'symlink_rejected'
  | 'drifted'
  | 'project_unresolved';

/** One instruction channel the engine ingests (ADR-093 §2.1). */
export type GovernanceLinkScope = 'user' | 'operator';
/** ADR-093 §4.1/§4.4 — why no link action is offered for this channel. */
export type GovernanceLinkRefusal =
  | 'no_mechanism'
  | 'symlink_by_design'
  | 'shared_source_is_the_file'
  | 'project_scoped'
  | 'owner_required';

export type GovernanceChannel = {
  id: string;
  scope: GovernanceScope;
  path: string | null;
  link: string | null;
  mechanism: GovernanceMechanism;
  verification: GovernanceVerification;
  enforcement: GovernanceEnforcement;
  status: GovernanceStatus;
  reason: GovernanceReason | null;
  /**
   * Whether THIS caller may establish this channel — decided by the SERVER (plan +
   * role + platform mode) and never re-derived here, so the button and the endpoint
   * can never disagree.
   */
  linkable: boolean;
  linkScope: GovernanceLinkScope | null;
  linkRefusal: GovernanceLinkRefusal | null;
};

export type GovernanceDescriptor = {
  provider: string;
  status: GovernanceStatus;
  enforced: boolean;
  mechanism: GovernanceMechanism;
  /**
   * ADR-093 channel list. `undefined` on a server that predates T-1195 — the
   * badge never reads it, and the sources panel hides rather than guessing.
   */
  sources?: GovernanceChannel[];
};

type GovernanceResponse = {
  success?: boolean;
  data?: {
    provider?: string;
    status?: string;
    enforced?: unknown;
    mechanism?: string;
    sources?: unknown;
  };
};

/**
 * Accepts a channel only if every field it carries is present and of the right
 * type — a half-understood channel is dropped, never rendered with holes. Same
 * fail-HIDDEN contract as the descriptor itself.
 */
export function parseChannels(raw: unknown): GovernanceChannel[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  const channels: GovernanceChannel[] = [];
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') return undefined;
    const c = entry as Record<string, unknown>;
    const status = c.status;
    if (
      typeof c.id !== 'string'
      || (c.scope !== 'user' && c.scope !== 'project')
      || (c.path !== null && typeof c.path !== 'string')
      || (c.link !== null && typeof c.link !== 'string')
      || typeof c.mechanism !== 'string'
      || typeof c.verification !== 'string'
      || typeof c.enforcement !== 'string'
      || (status !== 'governed' && status !== 'ungoverned')
      || (c.reason !== null && typeof c.reason !== 'string')
      // The link fields (T-1197) are tolerated as ABSENT — a server that only has
      // T-1195 still describes its channels truthfully, and hiding the whole panel
      // over a missing affordance would trade real information for none. Absent ⇒
      // no button, which is the safe reading. Present but malformed is still a
      // rejection: an affordance we cannot parse must never be rendered.
      || (c.linkable !== undefined && typeof c.linkable !== 'boolean')
      || (c.linkScope !== undefined && c.linkScope !== null
        && c.linkScope !== 'user' && c.linkScope !== 'operator')
      || (c.linkRefusal !== undefined && c.linkRefusal !== null
        && typeof c.linkRefusal !== 'string')
    ) {
      return undefined;
    }
    channels.push({
      id: c.id,
      scope: c.scope,
      path: (c.path as string | null) ?? null,
      link: (c.link as string | null) ?? null,
      mechanism: c.mechanism as GovernanceMechanism,
      verification: c.verification as GovernanceVerification,
      enforcement: c.enforcement as GovernanceEnforcement,
      status,
      reason: (c.reason as GovernanceReason | null) ?? null,
      linkable: c.linkable === true,
      linkScope: (c.linkScope as GovernanceLinkScope | null) ?? null,
      linkRefusal: (c.linkRefusal as GovernanceLinkRefusal | null) ?? null,
    });
  }
  return channels;
}

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
  /**
   * Bump to re-read the descriptor from disk — used after the link action so the
   * surface shows the verdict the SERVER re-read, never an optimistic local one
   * (ADR-093 §4/T-1197). Unused by the badge, whose call is unchanged.
   */
  refreshToken: number = 0,
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
            sources: parseChannels(data?.sources),
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
  }, [provider, refreshToken]);

  return descriptor;
}
