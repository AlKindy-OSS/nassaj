import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import type { LLMProvider } from '../../../types/app';

/**
 * Drives the per-user provider API-key CRUD store from the UI
 * (`/api/providers/:provider/api-key`, T-866/F1). Generalizes the legacy
 * hosted-vendor-only (kimi/deepseek/glm) hook to every capability-led
 * provider — claude/opencode/codex included — behind the same three routes:
 *
 *   GET    /api/providers/:provider/api-key  -> { configured: boolean }  (never the value)
 *   POST   /api/providers/:provider/api-key  -> upsert { apiKey, target? }
 *   DELETE /api/providers/:provider/api-key  -> remove (idempotent)
 *
 * `target` selects which internal credential slot to read/write for a
 * multi-target provider (opencode: anthropic/openai/openrouter); omit it for
 * single-target providers, where the backend writer applies its own implicit
 * default. The stored value is never read back — only whether a key is
 * configured. After a successful set/delete the caller can refresh the shared
 * `/auth/status` so the connection badge flips (ADR-030).
 */

/** Why the server would refuse a write from THIS caller. */
export type CredentialWriteRefusal = 'shared_requires_admin';

type ApiKeyStatusResponse = {
  success?: boolean;
  data?: {
    provider?: string;
    configured?: boolean;
    /**
     * B-362 — may THIS user write THIS slot. The capability descriptor cannot
     * answer this (it is role-free by design), so without it the entry surface
     * showed a field, a Save button and a "get a key" link to every member for
     * the four opencode slots that default to `shared`, and only refused with
     * 403 after they had bought a key and pasted it.
     */
    writable?: boolean;
    reason?: CredentialWriteRefusal;
  };
  error?: string;
  message?: string;
};

type MutationResult = { success: true } | { success: false; error: string };

async function readError(response: Response, fallback: string): Promise<string> {
  try {
    const payload = (await response.json()) as ApiKeyStatusResponse;
    return payload?.error ?? payload?.message ?? fallback;
  } catch {
    return fallback;
  }
}

export function useProviderApiKey(provider: LLMProvider, target?: string) {
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * `undefined` = not answered yet, or answered by a server that predates
   * `writable` (B-367). `false` = this user may genuinely not write this slot.
   *
   * THE DISTINCTION IS THE WHOLE FIX. Collapsing "no answer" into "denied" made
   * the client refuse EVERY slot the moment it shipped ahead of the server:
   * `Boolean(undefined)` is `false`, so a deploy that rebuilt the client and not
   * the server printed "you do not have permission" on all nine credentials —
   * for the owner too — and left no way to add a key at all.
   *
   * A client that is newer than its server must degrade to the server's OLD
   * behaviour, which was to allow the write and let the 403 speak. Locking
   * everyone out is a worse failure than the one the flag prevents, and unlike
   * it, it hits the operator.
   */
  const [writable, setWritable] = useState<boolean | undefined>(undefined);
  const [writeRefusal, setWriteRefusal] = useState<CredentialWriteRefusal | null>(null);

  const endpoint = `/api/providers/${provider}/api-key`;
  const queryString = target ? `?target=${encodeURIComponent(target)}` : '';

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${endpoint}${queryString}`);
      if (!response.ok) {
        setError(await readError(response, 'Failed to read API key status'));
        return;
      }
      const payload = (await response.json()) as ApiKeyStatusResponse;
      setConfigured(Boolean(payload.data?.configured));
      // Absent stays absent — see the state declaration. Only an explicit
      // `false` from a server that knows the field is a refusal.
      setWritable(payload.data?.writable);
      setWriteRefusal(payload.data?.reason ?? null);
    } catch {
      setError('Network error');
    } finally {
      setLoading(false);
    }
  }, [endpoint, queryString]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const saveKey = useCallback(
    async (apiKey: string): Promise<MutationResult> => {
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
          body: JSON.stringify(target ? { apiKey: trimmed, target } : { apiKey: trimmed }),
        });
        if (!response.ok) {
          const message = await readError(response, 'Failed to save API key');
          setError(message);
          return { success: false, error: message };
        }
        setConfigured(true);
        return { success: true };
      } catch {
        const message = 'Network error';
        setError(message);
        return { success: false, error: message };
      } finally {
        setSaving(false);
      }
    },
    [endpoint, target],
  );

  const deleteKey = useCallback(async (): Promise<MutationResult> => {
    setSaving(true);
    setError(null);
    try {
      const response = await authenticatedFetch(`${endpoint}${queryString}`, { method: 'DELETE' });
      if (!response.ok) {
        const message = await readError(response, 'Failed to remove API key');
        setError(message);
        return { success: false, error: message };
      }
      setConfigured(false);
      return { success: true };
    } catch {
      const message = 'Network error';
      setError(message);
      return { success: false, error: message };
    } finally {
      setSaving(false);
    }
  }, [endpoint, queryString]);

  return { configured, loading, saving, error, writable, writeRefusal, refresh, saveKey, deleteKey };
}
