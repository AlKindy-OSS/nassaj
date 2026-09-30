import { useCallback, useEffect, useId, useRef, useState, type FormEvent } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Fingerprint, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../shared/view/ui';

import {
  connectorStepUpErrorKey,
  loadStepUpMethod,
  ORIGIN_PROBLEM_CODES,
  passkeysSupported,
  startConnectorOidcStepUp,
  submitConnectorPasskeyStepUp,
  submitConnectorStepUp,
  type ConnectorReturnView,
  type ConnectorStepUpResult,
} from './connectorStepUpClient';

type Props = {
  open: boolean;
  /**
   * The installation owner stays local for emergency access even when linked
   * (server requiresSsoLogin), so an owner is never sent to the IdP.
   */
  owner?: boolean;
  /** Connector view to reopen after an IdP round trip. */
  returnView: ConnectorReturnView;
  /** A refusal to show on open (e.g. the outcome of a SSO return). */
  initialErrorCode?: string | null;
  onClose: () => void;
  /** Called after a 204: the recent-auth window is open; refetch readiness. */
  onVerified: () => void;
  /**
   * A 204 that arrived after the dialog was closed: the server may already
   * have set the connector cookies, so the tab refetches readiness silently.
   */
  onVerifiedAfterClose?: () => void;
};

type Mode = 'loading' | 'local' | 'sso';
type Busy = null | 'password' | 'passkey' | 'sso';
type Failure = { code: string; retryAfterSeconds?: number; via?: Busy };

const ORIGIN_UNCONFIGURED = 'CONNECTOR_RECENT_AUTH_ORIGIN_UNCONFIGURED';

/**
 * Inline connector step-up (T-1939 slice 6C). Replaces "sign out and sign in
 * again": local accounts confirm with their password or a passkey, SSO-linked
 * members with SSO. A wrong password is a code-bearing 401 and never ends
 * the session. Origin problems are explained, not answered with a password
 * prompt, because no credential can fix them.
 */
export default function ConnectorStepUpDialog({
  open, owner = false, returnView, initialErrorCode = null, onClose, onVerified, onVerifiedAfterClose,
}: Props) {
  const { t } = useTranslation('settings');
  const titleId = useId();
  const descriptionId = useId();
  const passwordId = useId();
  const [mode, setMode] = useState<Mode>('loading');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [redirecting, setRedirecting] = useState(false);
  // A 429 holds every submit button until its Retry-After has passed.
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const generation = useRef(0);
  // Aborted on close: a pending SSO start must not navigate after Cancel.
  const ssoStart = useRef<AbortController | null>(null);
  const k = (key: string, options?: Record<string, unknown>) => t(`connectorsSettings.stepUp.${key}`, options);

  useEffect(() => {
    if (!open) return undefined;
    const call = ++generation.current;
    const abort = new AbortController();
    setPassword(''); setBusy(null); setMode('loading'); setRedirecting(false); setLockedUntil(null);
    setFailure(initialErrorCode ? { code: initialErrorCode } : null);
    void loadStepUpMethod(owner ? 'owner' : null, abort.signal).then(method => {
      if (call === generation.current) setMode(method ?? 'local');
    });
    return () => {
      generation.current += 1;
      abort.abort();
      ssoStart.current?.abort();
      ssoStart.current = null;
      // Closing (or unmounting) drops the typed password from React state.
      setPassword('');
    };
  }, [open, initialErrorCode, owner]);

  useEffect(() => {
    if (lockedUntil === null) return undefined;
    const timer = setTimeout(() => setLockedUntil(null), Math.max(0, lockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [lockedUntil]);

  // Back from the IdP through the back/forward cache: the page never left for
  // good, so the SSO button must not stay busy.
  useEffect(() => {
    const onPageShow = (event: PageTransitionEvent) => {
      if (event.persisted) { setBusy(null); setRedirecting(false); }
    };
    window.addEventListener('pageshow', onPageShow);
    return () => window.removeEventListener('pageshow', onPageShow);
  }, []);

  const settle = useCallback((call: number, result: ConnectorStepUpResult, via: Busy) => {
    if (call !== generation.current) {
      if (result.ok) onVerifiedAfterClose?.();
      return;
    }
    setBusy(null);
    if (result.ok) {
      setPassword('');
      onVerified();
      return;
    }
    // Only a wrong password keeps the field for correction.
    if (result.code !== 'step_up_failed') setPassword('');
    // The server decides who must use SSO; follow it rather than guess.
    if (result.code === 'sso_step_up_required') setMode('sso');
    if (result.code === 'sso_step_up_not_applicable') setMode('local');
    if (result.code === 'passkey_cancelled') { setFailure(null); return; }
    if (result.retryAfterSeconds) setLockedUntil(Date.now() + result.retryAfterSeconds * 1000);
    setFailure({ code: result.code, retryAfterSeconds: result.retryAfterSeconds, via });
  }, [onVerified, onVerifiedAfterClose]);

  const locked = lockedUntil !== null;

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || locked || !password) return;
    const call = generation.current;
    setBusy('password'); setFailure(null);
    settle(call, await submitConnectorStepUp({ method: 'password', password }), 'password');
  };

  const confirmWithPasskey = async () => {
    if (busy || locked) return;
    const call = generation.current;
    setBusy('passkey'); setFailure(null);
    settle(call, await submitConnectorPasskeyStepUp(), 'passkey');
  };

  const confirmWithSso = async () => {
    if (busy || locked) return;
    const call = generation.current;
    setBusy('sso'); setFailure(null);
    ssoStart.current?.abort();
    const abort = new AbortController();
    ssoStart.current = abort;
    const started = await startConnectorOidcStepUp(returnView, { signal: abort.signal });
    if (ssoStart.current === abort) ssoStart.current = null;
    if (call !== generation.current) return;
    if (!started.ok) { settle(call, started, 'sso'); return; }
    // Another SSO navigation already started: say so; the dialog stays closable.
    if (started.outcome === 'in_flight') { setBusy(null); setRedirecting(true); }
    // 'redirected': the page is leaving; the button stays busy, Cancel stays live.
  };

  const originProblem = failure !== null && ORIGIN_PROBLEM_CODES.has(failure.code);
  // The owner is the one who can fix an unconfigured origin; tell them how.
  const errorKey = failure?.code === ORIGIN_UNCONFIGURED && owner
    ? 'errors.originUnconfiguredOwner'
    : failure ? connectorStepUpErrorKey(failure.code) : '';
  const errorText = failure && [
    k(errorKey),
    failure.retryAfterSeconds ? k('retryIn', { seconds: failure.retryAfterSeconds }) : '',
  ].filter(Boolean).join(' ');

  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent className="w-[calc(100%-2rem)] max-w-md p-5" aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-primary/10 p-2 text-primary"><ShieldCheck className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <DialogTitle id={titleId} className="not-sr-only text-base font-semibold text-foreground">{k('title')}</DialogTitle>
            <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{k('description')}</p>
          </div>
        </div>

        {failure && errorText && (
          <div role="alert" className="mt-4 flex items-start gap-2 rounded-md border border-danger/30 bg-danger/5 p-3 text-sm text-danger">
            <AlertCircle className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
            <span className="min-w-0 flex-1">
              {errorText}
              {originProblem && <span dir="ltr" className="mt-1 block break-all font-mono">{window.location.origin}</span>}
              <code dir="ltr" className="mt-1 block break-all text-[13px] opacity-75">{failure.code}</code>
            </span>
          </div>
        )}

        {!originProblem && mode === 'loading' && (
          <p role="status" className="mt-4 flex min-h-11 items-center justify-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{k('loading')}
          </p>
        )}

        {!originProblem && mode === 'local' && (
          <div className="mt-4 space-y-3">
            <form className="space-y-3" onSubmit={event => void submitPassword(event)}>
              <label htmlFor={passwordId} className="block text-sm font-medium text-foreground">{k('passwordLabel')}</label>
              <Input id={passwordId} type="password" autoComplete="current-password" dir="ltr" value={password}
                disabled={busy !== null || locked} onChange={event => setPassword(event.target.value)}
                aria-invalid={(failure?.via === 'password' && failure.code === 'step_up_failed') || undefined} />
              <Button type="submit" className="w-full" disabled={busy !== null || locked || !password}>
                {busy === 'password' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <KeyRound className="h-4 w-4" aria-hidden="true" />}
                {busy === 'password' ? k('confirming') : k('confirm')}
              </Button>
            </form>
            {passkeysSupported() && <>
              <p className="text-center text-[13px] text-muted-foreground">{k('or')}</p>
              <Button type="button" variant="outline" className="w-full" disabled={busy !== null || locked} onClick={() => void confirmWithPasskey()}>
                {busy === 'passkey' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <Fingerprint className="h-4 w-4" aria-hidden="true" />}
                {k('usePasskey')}
              </Button>
            </>}
          </div>
        )}

        {!originProblem && mode === 'sso' && (
          <div className="mt-4 space-y-3">
            <p className="text-sm text-foreground">{k('ssoDescription')}</p>
            {redirecting && (
              <p role="status" className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />{k('redirecting')}
              </p>
            )}
            <Button type="button" className="w-full" disabled={busy !== null || locked || redirecting} onClick={() => void confirmWithSso()}>
              {busy === 'sso' ? <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" /> : <ShieldCheck className="h-4 w-4" aria-hidden="true" />}
              {busy === 'sso' ? k('redirecting') : k('confirmWithSso')}
            </Button>
          </div>
        )}

        <div className="mt-4 flex justify-end">
          {/* Always live: closing aborts a pending SSO start; only a navigation
              the browser has already begun can no longer be stopped. */}
          <Button type="button" variant="ghost" onClick={onClose}>
            {originProblem ? k('close') : k('cancel')}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
