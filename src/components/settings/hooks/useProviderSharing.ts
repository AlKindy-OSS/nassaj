import { useCallback, useEffect, useState } from 'react';

import { filterDisabledProviders } from '../../../../shared/disabledProviders';
import { api } from '../../../utils/api';

/**
 * Providers whose credentials can be shared or isolated per user. Mirrors the
 * backend `KNOWN_PROVIDERS` in services/provider-sharing.js (note `agy`, not
 * `antigravity`, is the sharing-policy key). The hosted vendor providers
 * (kimi/deepseek/glm) hold a per-user API key and default to `isolated`.
 */
export type SharingProvider =
  | 'claude'
  | 'gemini'
  | 'codex'
  | 'agy'
  | 'cursor'
  | 'kimi'
  | 'deepseek'
  | 'glm';

/** Sharing mode for a single provider. */
export type SharingMode = 'shared' | 'isolated';

/** Full sharing configuration as returned/accepted by the admin API. */
export type ProviderSharingConfig = Record<SharingProvider, SharingMode>;

/**
 * Stable provider order used by the UI and as a fallback default. Globally
 * disabled providers (T-864) are filtered out so the sharing panel neither
 * renders nor edits their rows (antigravity's sharing key is `agy`, unaffected).
 */
export const SHARING_PROVIDERS: SharingProvider[] = filterDisabledProviders([
  'claude',
  'gemini',
  'codex',
  'agy',
  'cursor',
  'kimi',
  'deepseek',
  'glm',
]);

const DEFAULT_CONFIG: ProviderSharingConfig = {
  claude: 'isolated',
  gemini: 'isolated',
  codex: 'isolated',
  agy: 'shared',
  cursor: 'shared',
  kimi: 'isolated',
  deepseek: 'isolated',
  glm: 'isolated',
};

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as { error?: string; message?: string };
    return payload?.error ?? payload?.message ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Normalizes an arbitrary API payload into a complete sharing config, filling
 * any missing provider with the default so the UI never renders `undefined`.
 */
function normalizeConfig(raw: Partial<ProviderSharingConfig> | null | undefined): ProviderSharingConfig {
  const next = { ...DEFAULT_CONFIG };
  if (raw) {
    for (const provider of SHARING_PROVIDERS) {
      const value = raw[provider];
      if (value === 'shared' || value === 'isolated') {
        next[provider] = value;
      }
    }
  }
  return next;
}

type SaveResult = { success: true } | { success: false; error: string };

/**
 * Loads and mutates the per-provider credential sharing config (admin/owner).
 *
 * `updateConfig` mutates only local state (optimistic edit); `saveConfig`
 * persists the whole config via `PUT /api/admin/provider-sharing`. The hook
 * tracks a `dirty` flag so the UI can disable Save when there are no changes.
 */
export function useProviderSharing(enabled: boolean) {
  const [config, setConfig] = useState<ProviderSharingConfig>(DEFAULT_CONFIG);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await api.admin.getProviderSharing();
      if (!res.ok) {
        setError(await readError(res, 'Failed to load sharing config'));
        return;
      }
      const payload = (await res.json()) as Partial<ProviderSharingConfig>;
      setConfig(normalizeConfig(payload));
      setDirty(false);
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

  const updateConfig = useCallback((provider: SharingProvider, value: SharingMode) => {
    setConfig((previous) => {
      if (previous[provider] === value) {
        return previous;
      }
      return { ...previous, [provider]: value };
    });
    setDirty(true);
    setError(null);
  }, []);

  const saveConfig = useCallback(async (): Promise<SaveResult> => {
    setSaving(true);
    setError(null);
    try {
      const res = await api.admin.updateProviderSharing(config);
      if (!res.ok) {
        const message = await readError(res, 'Failed to save sharing config');
        setError(message);
        return { success: false, error: message };
      }
      const payload = (await res.json()) as { config?: Partial<ProviderSharingConfig> };
      if (payload.config) {
        setConfig(normalizeConfig(payload.config));
      }
      setDirty(false);
      return { success: true };
    } catch {
      const message = 'Network error';
      setError(message);
      return { success: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [config]);

  return {
    config,
    loading,
    saving,
    error,
    dirty,
    refresh,
    updateConfig,
    saveConfig,
  };
}
