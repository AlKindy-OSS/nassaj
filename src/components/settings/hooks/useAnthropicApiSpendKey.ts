/**
 * useAnthropicApiSpendKey — ADR-214 / T-2066: حالة مفتاح Anthropic Admin للمستخدم الحالي.
 *
 * الخادم لا يُعيد المفتاح أبداً، بل `{ configured }` فقط؛ والمفتاح يُمرَّر وسيطاً
 * إلى `saveKey` ثم يُنسى — لا يُحفظ في حالة هذا الخطّاف. وبعد كل حفظ/حذف ناجح
 * يُنبَّه مخزن الإنفاق كي تتبعه شارة الهيدر فوراً.
 */
import { useCallback, useEffect, useState } from 'react';

import { api } from '../../../utils/api';
import { refreshAnthropicApiSpend } from '../../quick-settings-panel/hooks/useAnthropicApiSpend';

/** رموز الخطأ التي تعرضها الواجهة. */
export type ApiSpendKeyError = 'INVALID_ADMIN_KEY' | 'LOAD_FAILED' | 'SAVE_FAILED' | 'DELETE_FAILED';

export type UseAnthropicApiSpendKeyResult = {
  configured: boolean;
  loading: boolean;
  saving: boolean;
  error: ApiSpendKeyError | null;
  saveKey: (key: string) => Promise<boolean>;
  deleteKey: () => Promise<boolean>;
};

async function readConfigured(response: Response): Promise<boolean | null> {
  try {
    const body = (await response.json()) as { configured?: unknown };
    return typeof body?.configured === 'boolean' ? body.configured : null;
  } catch {
    return null;
  }
}

async function readCode(response: Response): Promise<string | null> {
  try {
    return ((await response.json()) as { code?: string })?.code ?? null;
  } catch {
    return null;
  }
}

/** يقرأ حالة المفتاح ويوفّر الحفظ والحذف. */
export function useAnthropicApiSpendKey(): UseAnthropicApiSpendKeyResult {
  const [configured, setConfigured] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiSpendKeyError | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const response = await api.providers.anthropicApiSpendKey();
        const value = response.ok ? await readConfigured(response) : null;
        if (cancelled) return;
        if (value === null) setError('LOAD_FAILED');
        else setConfigured(value);
      } catch {
        if (!cancelled) setError('LOAD_FAILED');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const saveKey = useCallback(async (key: string): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const response = await api.providers.saveAnthropicApiSpendKey(key.trim());
      if (!response.ok) {
        const code = await readCode(response);
        setError(code === 'INVALID_ADMIN_KEY' ? 'INVALID_ADMIN_KEY' : 'SAVE_FAILED');
        return false;
      }
      setConfigured(true);
      refreshAnthropicApiSpend();
      return true;
    } catch {
      setError('SAVE_FAILED');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  const deleteKey = useCallback(async (): Promise<boolean> => {
    setSaving(true);
    setError(null);
    try {
      const response = await api.providers.deleteAnthropicApiSpendKey();
      if (!response.ok) {
        setError('DELETE_FAILED');
        return false;
      }
      setConfigured(false);
      refreshAnthropicApiSpend();
      return true;
    } catch {
      setError('DELETE_FAILED');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  return { configured, loading, saving, error, saveKey, deleteKey };
}
