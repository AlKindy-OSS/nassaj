import { useCallback, useEffect, useRef, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export type LocalModel = { id: string; name?: string; contextWindow?: number; maxOutput?: number };
export type LocalRuntime = 'ollama' | 'lmstudio' | 'llamacpp' | 'vllm' | 'other';
export const LOCAL_RUNTIMES = { ollama: 'Ollama', lmstudio: 'LM Studio', llamacpp: 'llama.cpp', vllm: 'vLLM', other: 'OpenAI-compatible' };
export type LocalServer = {
  id: string; providerId: string; name: string; baseUrl: string; runtime: LocalRuntime;
  models: LocalModel[]; hasApiKey: boolean; owned: boolean; ownerId: number;
  createdAt: string; updatedAt: string;
};
export type LocalServerInput = {
  name: string; baseUrl: string; runtime: LocalRuntime; models: LocalModel[];
  apiKey?: string; removeApiKey?: boolean;
};
type Feature = { enabled: boolean; consentVersion: string | null; requiredConsentVersion: string; canManage: boolean };
type Overview = { servers: LocalServer[]; total: number; limit: number; offset: number; feature: Feature };
const ROOT = '/api/providers/local';

/** Reads authenticated local-model responses without displaying backend/network details. */
async function request<T>(path: string, method = 'GET', body?: unknown): Promise<T> {
  const response = await authenticatedFetch(`${ROOT}${path}`, {
    method, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error('localModels.requestFailed');
  const result = await response.json();
  if (result.success !== true || !result.data) throw new Error('localModels.requestFailed');
  return result.data as T;
}

/** Keeps the local server list current; saving never starts a connection probe. */
export function useLocalModels() {
  const [overview, setOverview] = useState<Overview | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  const [error, setError] = useState('');
  const [offset, setOffset] = useState(0);
  const generation = useRef(0);
  const refresh = useCallback(async () => {
    const current = ++generation.current;
    setLoading(true);
    try {
      const next = await request<Overview>(`/servers?limit=50&offset=${offset}`);
      if (current === generation.current) { setOverview(next); setError(''); }
    } catch { if (current === generation.current) setError('loadFailed'); }
    finally { if (current === generation.current) setLoading(false); }
  }, [offset]);
  useEffect(() => { void refresh(); return () => { generation.current += 1; }; }, [refresh]);
  const act = async (operation: () => Promise<unknown>, success: string, failure: string) => {
    setBusy(true); setError(''); setMessage('');
    try {
      await operation();
      await refresh();
      setMessage(success);
      window.dispatchEvent(new CustomEvent('local-models-changed'));
      return true;
    } catch { setError(failure); return false; }
    finally { setBusy(false); }
  };
  return { overview, loading, busy, message, error, offset, setOffset, refresh,
    save: (input: LocalServerInput, id?: string) => act(() => request(id ? `/servers/${encodeURIComponent(id)}` : '/servers', id ? 'PATCH' : 'POST', input), 'saved', 'saveFailed'),
    remove: (id: string) => act(() => request(`/servers/${encodeURIComponent(id)}`, 'DELETE'), 'removed', 'removeFailed'),
    connect: (id: string) => act(() => request(`/servers/${encodeURIComponent(id)}/catalog`, 'POST'), 'connected', 'connectionFailed'),
    setEnabled: (enabled: boolean) => act(() => request('/settings', 'PUT', { enabled, consentVersion: overview?.feature.requiredConsentVersion }), 'settingsSaved', 'settingsFailed'),
  };
}
