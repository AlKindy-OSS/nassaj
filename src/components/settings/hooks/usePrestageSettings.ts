/**
 * T-2030 (ADR-207 decision 4): owner-only read/write of this node's update
 * prestage setting at `/api/system/update/prestage/settings`.
 *
 * The component stays presentational; parsing, validation and the error-code
 * mapping live here. Responses that arrive after an identity switch (or after a
 * newer request) are dropped through the same epoch + identity-barrier guard
 * as `useHarnessAutoUpdateSettings`.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { getIdentityBarrierSnapshot, subscribeIdentityBarrier } from '../../auth/accountIdentityBarrier';
import { authenticatedFetch } from '../../../utils/api';

export const PRESTAGE_SETTINGS_URL = '/api/system/update/prestage/settings';

export type PrestageDraft = { prestageEnabled: boolean; prestageQuarantineHours: number };

export type PrestageSettingsView = {
  settings: PrestageDraft;
  effective: { prestageEnabled: boolean; policy: string; prestageQuarantineHours: number };
  lockedByEnv: boolean;
  overriddenByEnv: { prestageEnabled: boolean; prestageQuarantineHours: boolean };
  defaults: PrestageDraft;
  limits: { minQuarantineHours: number; maxQuarantineHours: number };
};

/** Failure kinds the UI translates; server codes outside this list collapse to `save_failed`. */
export type PrestageErrorCode =
  | 'prestage_settings_invalid'
  | 'prestage_enabled_invalid'
  | 'prestage_quarantine_hours_invalid'
  | 'rate_limited'
  | 'forbidden'
  | 'save_failed';

const KNOWN_SERVER_CODES = new Set<PrestageErrorCode>([
  'prestage_settings_invalid', 'prestage_enabled_invalid', 'prestage_quarantine_hours_invalid', 'rate_limited',
]);

export const PRESTAGE_HOURS_FALLBACK_LIMITS = { minQuarantineHours: 0, maxQuarantineHours: 168 };

const identityKey = () => { const s = getIdentityBarrierSnapshot(); return `${s.version}:${s.phase}`; };

const isBool = (v: unknown): v is boolean => typeof v === 'boolean';
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Strict parse of the GET/PUT 200 body; anything malformed is treated as a failed read. */
export function parsePrestageSettings(body: unknown): PrestageSettingsView | null {
  if (!isRecord(body)) return null;
  const { settings, effective, overriddenByEnv, defaults, limits, lockedByEnv } = body;
  if (!isRecord(settings) || !isRecord(effective) || !isRecord(overriddenByEnv)
    || !isRecord(defaults) || !isRecord(limits) || !isBool(lockedByEnv)) return null;
  if (!isBool(settings.prestageEnabled) || !isNum(settings.prestageQuarantineHours)
    || !isBool(effective.prestageEnabled) || !isNum(effective.prestageQuarantineHours)
    || !isBool(overriddenByEnv.prestageEnabled) || !isBool(overriddenByEnv.prestageQuarantineHours)
    || !isBool(defaults.prestageEnabled) || !isNum(defaults.prestageQuarantineHours)
    || !isNum(limits.minQuarantineHours) || !isNum(limits.maxQuarantineHours)) return null;
  return {
    settings: { prestageEnabled: settings.prestageEnabled, prestageQuarantineHours: settings.prestageQuarantineHours },
    effective: {
      prestageEnabled: effective.prestageEnabled,
      policy: typeof effective.policy === 'string' ? effective.policy : '',
      prestageQuarantineHours: effective.prestageQuarantineHours,
    },
    lockedByEnv,
    overriddenByEnv: {
      prestageEnabled: overriddenByEnv.prestageEnabled,
      prestageQuarantineHours: overriddenByEnv.prestageQuarantineHours,
    },
    defaults: { prestageEnabled: defaults.prestageEnabled, prestageQuarantineHours: defaults.prestageQuarantineHours },
    limits: { minQuarantineHours: limits.minQuarantineHours, maxQuarantineHours: limits.maxQuarantineHours },
  };
}

/** Client-side mirror of the server bound: an integer within the advertised limits. */
export function isValidQuarantineHours(value: number, limits = PRESTAGE_HOURS_FALLBACK_LIMITS): boolean {
  return Number.isSafeInteger(value) && value >= limits.minQuarantineHours && value <= limits.maxQuarantineHours;
}

async function readErrorCode(response: Response): Promise<PrestageErrorCode> {
  if (response.status === 403) return 'forbidden';
  if (response.status === 429) return 'rate_limited';
  const body = await response.json().catch(() => null) as { code?: unknown } | null;
  const code = typeof body?.code === 'string' ? body.code as PrestageErrorCode : null;
  return code && KNOWN_SERVER_CODES.has(code) ? code : 'save_failed';
}

/**
 * Loads the prestage setting for the owner and exposes `save(draft)`.
 * `status` is `loading` | `saving` | `idle` | `load_error`; `saveError` keeps the last
 * failed save's code until the next save starts.
 */
export function usePrestageSettings(isOwner: boolean) {
  const [view, setView] = useState<PrestageSettingsView | null>(null);
  const [status, setStatus] = useState<'idle' | 'loading' | 'saving' | 'load_error'>('idle');
  const [saveError, setSaveError] = useState<PrestageErrorCode | null>(null);
  const [savedAt, setSavedAt] = useState(0);
  const epoch = useRef(0);
  const current = useCallback((request: number, identity: string) => (
    request === epoch.current && identity === identityKey()
  ), []);

  const load = useCallback(async () => {
    if (!isOwner) return;
    const request = ++epoch.current;
    const identity = identityKey();
    setStatus('loading');
    try {
      const response = await authenticatedFetch(PRESTAGE_SETTINGS_URL);
      if (!current(request, identity)) return;
      if (!response.ok) throw new Error('read_failed');
      const parsed = parsePrestageSettings(await response.json());
      if (!current(request, identity)) return;
      if (!parsed) throw new Error('invalid_settings');
      setView(parsed);
      setStatus('idle');
    } catch {
      if (current(request, identity)) setStatus('load_error');
    }
  }, [isOwner, current]);

  const save = useCallback(async (draft: PrestageDraft) => {
    if (!isOwner || !view) return;
    if (!isValidQuarantineHours(draft.prestageQuarantineHours, view.limits)) {
      setSaveError('prestage_quarantine_hours_invalid');
      return;
    }
    const request = ++epoch.current;
    const identity = identityKey();
    setStatus('saving');
    setSaveError(null);
    try {
      const response = await authenticatedFetch(PRESTAGE_SETTINGS_URL, {
        method: 'PUT',
        body: JSON.stringify({
          prestageEnabled: draft.prestageEnabled,
          prestageQuarantineHours: draft.prestageQuarantineHours,
        }),
      });
      if (!current(request, identity)) return;
      if (!response.ok) {
        const code = await readErrorCode(response);
        if (current(request, identity)) { setSaveError(code); setStatus('idle'); }
        return;
      }
      const parsed = parsePrestageSettings(await response.json());
      if (!current(request, identity)) return;
      if (!parsed) throw new Error('invalid_settings');
      setView(parsed);
      setSavedAt(Date.now());
      setStatus('idle');
    } catch {
      if (current(request, identity)) { setSaveError('save_failed'); setStatus('idle'); }
    }
  }, [isOwner, view, current]);

  useEffect(() => {
    const reset = () => { epoch.current += 1; setView(null); setStatus('idle'); setSaveError(null); };
    if (!isOwner) { reset(); return; }
    void load();
    const unsubscribe = subscribeIdentityBarrier(() => {
      reset();
      if (getIdentityBarrierSnapshot().phase === 'stable') void load();
    });
    return () => { epoch.current += 1; unsubscribe(); };
  }, [isOwner, load]);

  return { view, status, saveError, savedAt, save, reload: load };
}
