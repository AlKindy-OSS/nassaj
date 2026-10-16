/**
 * State and actions of the owner SSO settings tab (ADR-194 D8, T-1962 S7).
 *
 * Holds the `GET /api/settings/sso` read model, the last connection check and
 * the one-time test sign-in result (memory only: it carries the owner's own
 * claim values, so it is never persisted). Every write refreshes the read
 * model on success; failures come back as coded results for the UI to map.
 *
 * On mount it consumes the test sign-in return parameters (`ssoTest` /
 * `ssoTestError`) and removes them from the URL, because the result is
 * one-time and a reload must not try to read it again.
 */
import { useCallback, useEffect, useRef, useState } from 'react';

import { ssoApi } from '../view/tabs/sso-settings/ssoApi';
import type {
  SsoActionResult,
  SsoDiscoveryResult,
  SsoDraftForm,
  SsoStatus,
  SsoTestResult,
  StepUpEvidence,
} from '../view/tabs/sso-settings/ssoTypes';

export type SsoTestReturn =
  | { kind: 'result'; result: SsoTestResult }
  | { kind: 'alreadyShown' }
  | { kind: 'error'; code: string };

const SAFE_PARAM = /^[A-Za-z0-9_:.-]{1,128}$/;

/** The minimum shape the tab reads; anything else is a load failure, never a crash. */
function isSsoStatus(value: unknown): value is SsoStatus {
  const v = value as Partial<SsoStatus> | null;
  return Boolean(v && typeof v === 'object' && typeof v.ssoState === 'string' && v.ourValues && typeof v.ourValues === 'object'
    && v.lastProofs && typeof v.lastProofs === 'object' && Array.isArray(v.identityCountsByIssuer));
}

/** Reads and strips the test sign-in return parameters. */
function takeTestReturnParams(): { id: string | null; error: string | null } {
  if (typeof window === 'undefined') return { id: null, error: null };
  const url = new URL(window.location.href);
  const id = url.searchParams.get('ssoTest');
  const error = url.searchParams.get('ssoTestError');
  if (id === null && error === null) return { id: null, error: null };
  url.searchParams.delete('ssoTest');
  url.searchParams.delete('ssoTestError');
  window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  return {
    id: id && SAFE_PARAM.test(id) ? id : null,
    error: error === null ? null : (SAFE_PARAM.test(error) ? error : 'unknown'),
  };
}

export function useSsoSettings() {
  const [status, setStatus] = useState<SsoStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [discovery, setDiscovery] = useState<SsoDiscoveryResult | null>(null);
  const [testReturn, setTestReturn] = useState<SsoTestReturn | null>(null);
  const [lastTestResult, setLastTestResult] = useState<SsoTestResult | null>(null);
  const mounted = useRef(true);
  const hasStatus = useRef(false);

  const reload = useCallback(async (): Promise<boolean> => {
    const result = await ssoApi.status();
    if (!mounted.current) return false;
    if (result.ok && !isSsoStatus(result.data)) {
      if (!hasStatus.current) setLoadError('invalid_response');
      setLoading(false);
      return false;
    }
    if (result.ok) {
      hasStatus.current = true;
      setStatus(result.data);
      setLoadError(null);
    } else if (!hasStatus.current) {
      setLoadError(result.code);
    }
    setLoading(false);
    return result.ok;
  }, []);

  useEffect(() => {
    mounted.current = true;
    const { id, error } = takeTestReturnParams();
    if (error) setTestReturn({ kind: 'error', code: error });
    if (id) {
      void ssoApi.testResult(id).then((result) => {
        if (!mounted.current) return;
        if (result.ok && result.data?.result) {
          setTestReturn({ kind: 'result', result: result.data.result });
          setLastTestResult(result.data.result);
        } else {
          setTestReturn(result.ok || result.status === 404 ? { kind: 'alreadyShown' } : { kind: 'error', code: result.code });
        }
      });
    }
    void reload();
    return () => { mounted.current = false; };
    // Mount only: the return parameters are consumed once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** Runs a write and refreshes the read model when it succeeded. */
  const write = useCallback(async <T,>(run: () => Promise<SsoActionResult<T>>): Promise<SsoActionResult<T>> => {
    const result = await run();
    if (result.ok) await reload();
    return result;
  }, [reload]);

  const saveDraft = useCallback((form: SsoDraftForm, stepUp?: StepUpEvidence) => {
    const expected = status?.draft?.draftVersion;
    return write(() => ssoApi.saveDraft(form, expected, stepUp));
  }, [status?.draft?.draftVersion, write]);

  const testDiscovery = useCallback(async () => {
    const result = await write(() => ssoApi.testDiscovery());
    if (result.ok && mounted.current) setDiscovery({ ...result.data, checkedAt: Date.now() });
    return result;
  }, [write]);

  /** Starts the test sign-in; on success the page navigates to the identity provider. */
  const startTestLogin = useCallback(async (assign: (url: string) => void = (url) => window.location.assign(url)) => {
    const result = await ssoApi.startTestLogin();
    if (result.ok) {
      const url = result.data.authorizationUrl;
      if (typeof url !== 'string' || !/^https?:\/\//i.test(url)) {
        return { ok: false, code: 'temporarily_unavailable', status: 502 } as const;
      }
      assign(url);
    }
    return result;
  }, []);

  const apply = useCallback((options: { enable?: boolean; keepOrphanedSessions?: boolean; confirmation?: string },
    stepUp: StepUpEvidence) => {
    const draft = status?.draft;
    if (!draft) return Promise.resolve({ ok: false, code: 'sso_draft_missing', status: 404 } as const);
    return write(() => ssoApi.apply({
      draftVersion: draft.draftVersion, configHash: draft.configHash, ...options, stepUp,
    }));
  }, [status?.draft, write]);

  const enable = useCallback((stepUp: StepUpEvidence) => write(() => ssoApi.enable(stepUp)), [write]);
  const disable = useCallback((keepLinkedSessions: boolean, stepUp?: StepUpEvidence) =>
    write(() => ssoApi.disable({ ...(keepLinkedSessions ? { keepLinkedSessions: true } : {}), ...(stepUp ? { stepUp } : {}) })),
  [write]);
  const importEnv = useCallback(() => write(() => ssoApi.importEnv()), [write]);
  const confirmOrigin = useCallback((origin: string, stepUp: StepUpEvidence) =>
    write(() => ssoApi.confirmOrigin(origin, stepUp)), [write]);

  return {
    status, loading, loadError, discovery, testReturn, lastTestResult,
    reload, saveDraft, testDiscovery, startTestLogin, apply, enable, disable, importEnv, confirmOrigin,
    dismissTestReturn: () => setTestReturn(null),
  };
}
