import { useCallback, useEffect, useState } from 'react';

import { filterDisabledProviders } from '../../../../shared/disabledProviders';
import { api } from '../../../utils/api';

/**
 * Providers a member may delegate their credential for (T-1675). Mirrors the
 * backend `GRANTABLE_PROVIDERS` (every known provider). Note the
 * policy key is `agy`, not `antigravity` — the one place the two spaces differ.
 */
export type GrantProvider =
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'agy'
  | 'opencode'
  | 'cursor'
  | 'hermes'
  | 'kimi'
  | 'deepseek'
  | 'glm'
  | 'qwen';

const GRANT_PROVIDERS: GrantProvider[] = filterDisabledProviders([
  'claude',
  'gemini',
  'codex',
  'agy',
  'opencode',
  'cursor',
  'hermes',
  'kimi',
  'deepseek',
  'glm',
  'qwen',
]);

/**
 * Agents-settings agent id → grant unit. `antigravity` is keyed `agy` in the
 * policy, and gemini/agy are ONE credential on disk, so both pages edit the
 * `gemini` grant (mirrors `credentialUnit` on the server). Agents with no
 * credential to delegate (sakana) map to `null`, so the Account tab renders
 * no sharing section for them.
 */
export function agentToGrantProvider(agent: string): GrantProvider | null {
  const key = agent === 'antigravity' ? 'agy' : agent;
  if (!GRANT_PROVIDERS.includes(key as GrantProvider)) {
    return null;
  }
  return key === 'agy' ? 'gemini' : (key as GrantProvider);
}

/** A grant the caller OWNS: who they shared with and that member's answer. */
export type GivenGrant = {
  provider: string;
  userId: number;
  username: string;
  /** The grantee parked it and runs on their own credential. */
  declined: boolean;
  createdAt: string;
};

/** A grant OFFERED to the caller. */
export type ReceivedGrant = {
  provider: string;
  ownerUserId: number;
  ownerUsername: string;
  declined: boolean;
  createdAt: string;
  /** The one this member's spawns actually run on right now. */
  inUse: boolean;
};

export type GrantMember = { id: number; username: string };

export type CredentialGrantsOverview = {
  providers: string[];
  given: GivenGrant[];
  received: ReceivedGrant[];
  members: GrantMember[];
};

const EMPTY: CredentialGrantsOverview = { providers: [], given: [], received: [], members: [] };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    return payload?.error ?? payload?.message ?? fallback;
  } catch {
    return fallback;
  }
}

async function readOverview(response: Response): Promise<CredentialGrantsOverview> {
  const payload = (await response.json()) as { data?: Partial<CredentialGrantsOverview> };
  const data = payload?.data ?? {};
  return {
    providers: Array.isArray(data.providers) ? data.providers : [],
    given: Array.isArray(data.given) ? data.given : [],
    received: Array.isArray(data.received) ? data.received : [],
    members: Array.isArray(data.members) ? data.members : [],
  };
}

/**
 * The caller's credential-grant picture and the two self-scoped writes:
 * `setGrantees` (as owner: whom my credential is shared with, per provider) and
 * `selectGrant` (as grantee: which offered grant I run on, `null` = my own).
 * Every write returns the server's fresh overview, so the UI never guesses.
 */
export function useCredentialGrants(enabled: boolean) {
  const [overview, setOverview] = useState<CredentialGrantsOverview>(EMPTY);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.credentialGrants.overview();
      if (!res.ok) {
        setError(await readError(res, 'Failed to load credential sharing'));
        return;
      }
      setOverview(await readOverview(res));
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (enabled) {
      void refresh();
    }
  }, [enabled, refresh]);

  const applyWrite = useCallback(async (request: () => Promise<Response>, fallback: string) => {
    setSaving(true);
    setError(null);
    try {
      const res = await request();
      if (!res.ok) {
        setError(await readError(res, fallback));
        return false;
      }
      setOverview(await readOverview(res));
      return true;
    } catch {
      setError('Network error');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const setGrantees = useCallback(
    (provider: GrantProvider, userIds: number[]) =>
      applyWrite(() => api.credentialGrants.setGrantees(provider, userIds), 'Failed to update sharing'),
    [applyWrite],
  );

  const selectGrant = useCallback(
    (provider: GrantProvider, ownerUserId: number | null) =>
      applyWrite(() => api.credentialGrants.use(provider, ownerUserId), 'Failed to switch credential'),
    [applyWrite],
  );

  return { overview, loading, saving, error, refresh, setGrantees, selectGrant };
}
