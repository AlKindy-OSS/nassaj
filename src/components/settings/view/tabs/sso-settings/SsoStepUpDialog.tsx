import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Fingerprint, KeyRound, Loader2, ShieldCheck } from 'lucide-react';

import { Button, Dialog, DialogContent, DialogTitle, Input } from '../../../../../shared/view/ui';
import { collectStepUpEvidence } from '../../../../auth/hooks/useWebAuthn';
import { passkeysSupported } from '../connectorStepUpClient';

import { STEP_UP_DIALOG_CODES } from './ssoMessages';
import { SsoError } from './SsoParts';
import type { SsoActionFailure, SsoActionResult, StepUpEvidence } from './ssoTypes';

type Props = {
  open: boolean;
  /** Optional context shown above the form (e.g. the private-network note). */
  intro?: ReactNode;
  onClose: () => void;
  /** Runs the guarded write with the evidence. */
  onSubmit: (stepUp: StepUpEvidence) => Promise<SsoActionResult>;
  /** The write finished (success, or a refusal that is not about the step-up). The dialog closes. */
  onDone: (result: SsoActionResult) => void;
  /** Opens Profile, for `password_change_required`. */
  onOpenProfile?: () => void;
};

type Busy = null | 'password' | 'passkey';

/**
 * Step-up for SSO configuration (ADR-194 D8, brief §6.5): local password or
 * passkey only — an SSO grant never authorizes SSO configuration, so there is
 * no SSO option. Modelled on ConnectorStepUpDialog. Step-up refusals (wrong
 * password, lockout) stay in the dialog; any other outcome is handed back.
 */
export default function SsoStepUpDialog({ open, intro, onClose, onSubmit, onDone, onOpenProfile }: Props) {
  const { t } = useTranslation('settings');
  const titleId = useId();
  const descriptionId = useId();
  const passwordId = useId();
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState<Busy>(null);
  const [failure, setFailure] = useState<SsoActionFailure | null>(null);
  const [lockedUntil, setLockedUntil] = useState<number | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    if (!open) return undefined;
    generation.current += 1;
    setPassword(''); setBusy(null); setFailure(null); setLockedUntil(null);
    return () => { generation.current += 1; setPassword(''); };
  }, [open]);

  useEffect(() => {
    if (lockedUntil === null) return undefined;
    const timer = setTimeout(() => setLockedUntil(null), Math.max(0, lockedUntil - Date.now()));
    return () => clearTimeout(timer);
  }, [lockedUntil]);

  const settle = (call: number, result: SsoActionResult) => {
    if (call !== generation.current) return;
    setBusy(null);
    if (result.ok || !STEP_UP_DIALOG_CODES.has(result.code)) {
      setPassword('');
      onDone(result);
      return;
    }
    if (result.code === 'passkey_cancelled') { setFailure(null); return; }
    if (result.code !== 'step_up_failed') setPassword('');
    if (result.retryAfterSeconds) setLockedUntil(Date.now() + result.retryAfterSeconds * 1000);
    setFailure(result);
  };

  const submitPassword = async (event: FormEvent) => {
    event.preventDefault();
    if (busy || lockedUntil !== null || !password) return;
    const call = generation.current;
    setBusy('password'); setFailure(null);
    settle(call, await onSubmit({ method: 'password', password }));
  };

  const confirmWithPasskey = async () => {
    if (busy || lockedUntil !== null) return;
    const call = generation.current;
    setBusy('passkey'); setFailure(null);
    const collected = await collectStepUpEvidence({ method: 'passkey' }, 'sso_config');
    if (!collected.ok) {
      const { failure: f } = collected;
      const code = f.kind === 'cancelled' ? 'passkey_cancelled'
        : f.kind === 'network' ? 'network'
          : !f.code || f.code === 'step_up_failed' ? 'passkey_failed' : f.code;
      settle(call, { ok: false, code, status: 0, retryAfterSeconds: f.retryAfterSeconds });
      return;
    }
    const result = await onSubmit(collected.evidence);
    settle(call, !result.ok && result.code === 'step_up_failed' ? { ...result, code: 'passkey_failed' } : result);
  };

  const locked = lockedUntil !== null;
  const mustChangePassword = failure?.code === 'password_change_required';

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent layerClassName="z-[10000]" className="w-[calc(100%-2rem)] max-w-md p-5"
        aria-labelledby={titleId} aria-describedby={descriptionId}>
        <div className="flex items-start gap-3">
          <span className="rounded-lg bg-primary/10 p-2 text-primary"><ShieldCheck className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <DialogTitle id={titleId} className="not-sr-only text-base font-semibold text-foreground">{t('sso.stepUp.title')}</DialogTitle>
            <p id={descriptionId} className="mt-1 text-sm text-muted-foreground">{t('sso.stepUp.description')}</p>
          </div>
        </div>

        {intro && <div className="mt-4 text-sm text-foreground">{intro}</div>}

        {failure && !mustChangePassword && (
          <div className="mt-4"><SsoError code={failure.code} details={failure.details} retryAfterSeconds={failure.retryAfterSeconds} /></div>
        )}

        {mustChangePassword ? (
          <div className="mt-4 space-y-3">
            <p role="alert" className="text-sm text-foreground">{t('sso.diag.password_change_required')}</p>
            {onOpenProfile && <Button type="button" variant="link" className="h-auto px-0" onClick={onOpenProfile}>{t('sso.stepUp.openProfile')}</Button>}
          </div>
        ) : (
          <div className="mt-4 space-y-3">
            <form className="space-y-3" onSubmit={(event) => { void submitPassword(event); }}>
              <label htmlFor={passwordId} className="block text-sm font-medium text-foreground">{t('sso.stepUp.passwordLabel')}</label>
              <Input id={passwordId} type="password" autoComplete="current-password" dir="ltr" value={password}
                disabled={busy !== null || locked} onChange={(event) => setPassword(event.target.value)}
                aria-invalid={failure?.code === 'step_up_failed' || undefined} />
              <Button type="submit" className="w-full" disabled={busy !== null || locked || !password}>
                {busy === 'password' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <KeyRound aria-hidden="true" />}
                {busy === 'password' ? t('sso.stepUp.confirming') : t('sso.stepUp.confirm')}
              </Button>
            </form>
            {passkeysSupported() && <>
              <p className="text-center text-[13px] text-muted-foreground">{t('sso.stepUp.or')}</p>
              <Button type="button" variant="outline" className="w-full" disabled={busy !== null || locked}
                onClick={() => { void confirmWithPasskey(); }}>
                {busy === 'passkey' ? <Loader2 className="animate-spin" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}
                {t('sso.stepUp.usePasskey')}
              </Button>
            </>}
          </div>
        )}

        <div className="mt-4 flex justify-end">
          <Button type="button" variant="outline"  onClick={onClose}>{t('sso.dialog.cancel')}</Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
