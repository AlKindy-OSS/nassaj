import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

import { NETWORK_FAILURE, readApiFailure, type ApiFailure, type LinkHarness, type LinkMode } from './vendorKeyApi';

/**
 * `GET|PUT /api/providers/:provider/link-mode` (ADR-200 S4, S9). Claude and Codex
 * only. The server answers `{ enabled: false }` while the fan-out flag is OFF,
 * which this hook reads as "no link-mode surface": it returns `status: null` and
 * the account page renders nothing extra.
 */

export type EffectiveLinkMode = LinkMode | 'none';

export type LinkKeyState = 'none' | 'managed' | 'adopted' | 'foreign';

export type LinkModeWarning =
  | 'effective_mode_mismatch'
  | 'fresh_subscription_login'
  | 'foreign_key_billing'
  | 'subscription_also_present'
  | 'mode_unset'
  | 'record_unreadable';

export type LinkModeStatus = {
  provider: LinkHarness;
  enabled: true;
  chosenMode: LinkMode | null;
  chosenModeSource: 'derived' | 'user' | 'setup_token' | null;
  effectiveMode: EffectiveLinkMode;
  linkState: 'linked' | 'unlinked';
  credentials: { key: LinkKeyState; subscription: boolean };
  warnings: LinkModeWarning[];
  /** Members running on this tree through an accepted grant. */
  granteeCount: number;
};

export type SwitchOutcome =
  | 'unchanged' | 'linked' | 'awaiting_key' | 'foreign_credential' | 'adopted_credential'
  | 'key_removed' | 'foreign_key_removed' | 'no_key';

export type SwitchRequest = {
  mode: LinkMode;
  removeForeignKey?: boolean;
  removeSetupToken?: boolean;
};

type StatusResponse = { data?: LinkModeStatus | { enabled: false } };
type SwitchResponse = { data?: { outcome?: SwitchOutcome; status?: LinkModeStatus } };

const isEnabled = (value: unknown): value is LinkModeStatus =>
  Boolean(value) && (value as { enabled?: unknown }).enabled === true;

export function useLinkMode(harness: LinkHarness) {
  const [status, setStatus] = useState<LinkModeStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<ApiFailure | null>(null);
  const [outcome, setOutcome] = useState<SwitchOutcome | null>(null);
  const endpoint = `/api/providers/${harness}/link-mode`;

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch(endpoint);
      if (!response.ok) {
        setStatus(null);
        return;
      }
      const data = ((await response.json()) as StatusResponse).data;
      setStatus(isEnabled(data) ? data : null);
    } catch {
      setStatus(null);
    } finally {
      setLoading(false);
    }
  }, [endpoint]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  /** The explicit, confirmed switch; the confirm the server demands is the dialog the caller just showed. */
  const switchMode = useCallback(async (request: SwitchRequest): Promise<boolean> => {
    setSaving(true);
    setFailure(null);
    setOutcome(null);
    try {
      const response = await authenticatedFetch(endpoint, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...request, confirm: true }),
      });
      if (!response.ok) {
        setFailure(await readApiFailure(response, 'Failed to switch the link mode'));
        return false;
      }
      const data = ((await response.json()) as SwitchResponse).data;
      setOutcome(data?.outcome ?? null);
      if (isEnabled(data?.status)) setStatus(data.status);
      else await refresh();
      return true;
    } catch {
      setFailure(NETWORK_FAILURE);
      return false;
    } finally {
      setSaving(false);
    }
  }, [endpoint, refresh]);

  return { status, loading, saving, failure, outcome, refresh, switchMode };
}

let enabledProbe: Promise<boolean> | null = null;

/**
 * Whether the unified vendor-key mode is ON for this server. The link-mode GET
 * is the only client-visible switch (`enabled: true|false`), so it is probed
 * and its positive answer is shared per page load. `false` until it answers, which keeps the
 * flag-OFF behaviour of every consumer the safe default.
 */
export function useUnifiedKeysEnabled(): boolean {
  const [enabled, setEnabled] = useState(false);
  useEffect(() => {
    let live = true;
    enabledProbe ??= authenticatedFetch('/api/providers/claude/link-mode')
      .then(async (response) => response.ok && isEnabled(((await response.json()) as StatusResponse).data))
      .catch(() => false)
      .then((value) => {
        // Only a positive answer is kept: a probe sent before login must not pin `false`.
        if (!value) enabledProbe = null;
        return value;
      });
    void enabledProbe.then((value) => { if (live) setEnabled(value); });
    return () => { live = false; };
  }, []);
  return enabled;
}
