/**
 * Hook for the owner setting "API key validity for SSO members" (T-1946).
 *
 * The server refuses an SSO-linked member's API key once their last single
 * sign-on is older than `windowDays`. This reads and writes that number over
 * `GET|PUT /api/settings/api-key-sso-window` (owner only). Range limits come
 * from the server response so the client never drifts from what it enforces.
 */
import { useCallback, useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';

export const API_KEY_SSO_WINDOW_DEFAULT_DAYS = 7;
export const API_KEY_SSO_WINDOW_MIN_DAYS = 1;
export const API_KEY_SSO_WINDOW_MAX_DAYS = 365;

export type ApiKeySsoWindowErrorKind = 'load' | 'invalid' | 'forbidden' | 'conflict' | 'save';

type WindowResponse = {
  windowDays?: unknown;
  defaultDays?: unknown;
  minDays?: unknown;
  maxDays?: unknown;
  code?: string;
};

type WindowLimits = { defaultDays: number; minDays: number; maxDays: number };

const FALLBACK_LIMITS: WindowLimits = {
  defaultDays: API_KEY_SSO_WINDOW_DEFAULT_DAYS,
  minDays: API_KEY_SSO_WINDOW_MIN_DAYS,
  maxDays: API_KEY_SSO_WINDOW_MAX_DAYS,
};

function readInt(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fallback;
}

function readLimits(payload: WindowResponse): WindowLimits {
  return {
    defaultDays: readInt(payload.defaultDays, FALLBACK_LIMITS.defaultDays),
    minDays: readInt(payload.minDays, FALLBACK_LIMITS.minDays),
    maxDays: readInt(payload.maxDays, FALLBACK_LIMITS.maxDays),
  };
}

/** Parses a draft into a whole number of days inside the limits, or null. */
export function parseWindowDays(draft: string, limits: WindowLimits = FALLBACK_LIMITS): number | null {
  const trimmed = draft.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const value = Number(trimmed);
  return value >= limits.minDays && value <= limits.maxDays ? value : null;
}

function errorKindForStatus(status: number, code: string | undefined): ApiKeySsoWindowErrorKind {
  if (status === 400 || code === 'invalid_window_days') return 'invalid';
  if (status === 403) return 'forbidden';
  if (status === 409 || code === 'identity_changed') return 'conflict';
  return 'save';
}

export function useApiKeySsoWindow() {
  const [windowDays, setWindowDays] = useState<number | null>(null);
  const [limits, setLimits] = useState<WindowLimits>(FALLBACK_LIMITS);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<ApiKeySsoWindowErrorKind | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await authenticatedFetch('/api/settings/api-key-sso-window');
      if (!response.ok) throw new Error(String(response.status));
      const payload = await response.json() as WindowResponse;
      const nextLimits = readLimits(payload);
      setLimits(nextLimits);
      setWindowDays(readInt(payload.windowDays, nextLimits.defaultDays));
      setError(null);
    } catch {
      setWindowDays(null);
      setError('load');
    } finally {
      setLoading(false);
    }
  }, []);

  /** Saves `next`; returns true only when the server accepted it. */
  const save = useCallback(async (next: number): Promise<boolean> => {
    setSaving(true);
    setError(null);
    setSavedAt(null);
    try {
      const response = await authenticatedFetch('/api/settings/api-key-sso-window', {
        method: 'PUT',
        body: JSON.stringify({ windowDays: next }),
      });
      const payload = await response.json().catch(() => ({})) as WindowResponse;
      if (!response.ok) {
        setError(errorKindForStatus(response.status, payload.code));
        return false;
      }
      const nextLimits = readLimits(payload);
      setLimits(nextLimits);
      setWindowDays(readInt(payload.windowDays, next));
      setSavedAt(Date.now());
      return true;
    } catch {
      setError('save');
      return false;
    } finally {
      setSaving(false);
    }
  }, []);

  /** Drops a stale "saved"/error message once the owner edits the draft again. */
  const clearStatus = useCallback(() => {
    setSavedAt(null);
    setError(null);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  return { windowDays, limits, loading, saving, error, savedAt, save, reload: load, clearStatus };
}
