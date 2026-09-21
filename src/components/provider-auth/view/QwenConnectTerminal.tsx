import { CheckCircle2, Loader2, ShieldCheck, Terminal } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useTranslation } from 'react-i18next';

import { authenticatedFetch } from '../../../utils/api';

type QwenPlan = 'coding_plan' | 'token_plan';
type QwenRegion = 'china' | 'international';
type Phase = 'editing' | 'saving' | 'success';

type QwenConnectTerminalProps = {
  onComplete?: (exitCode: number) => void;
  onClose: () => void;
};

export default function QwenConnectTerminal({ onComplete, onClose }: QwenConnectTerminalProps) {
  const { t } = useTranslation('settings');
  const [plan, setPlan] = useState<QwenPlan | null>(null);
  const [region, setRegion] = useState<QwenRegion>('international');
  const [apiKey, setApiKey] = useState('');
  const [phase, setPhase] = useState<Phase>('editing');
  const [error, setError] = useState<string | null>(null);
  const errorRef = useRef<HTMLParagraphElement | null>(null);
  const doneRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (error) errorRef.current?.focus();
  }, [error]);

  useEffect(() => {
    if (phase === 'success') doneRef.current?.focus();
  }, [phase]);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!plan || !apiKey.trim()) return;
    setPhase('saving');
    setError(null);
    try {
      const response = await authenticatedFetch('/api/providers/qwen/api-key', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ apiKey: apiKey.trim(), plan, region }),
      });
      if (!response.ok) {
        // Never render a server-provided message here: a proxy or upstream
        // validator could reflect submitted material. The secret stays inside
        // the password control and is never copied into terminal output.
        throw new Error('save_failed');
      }
      setApiKey('');
      setPhase('success');
      onComplete?.(0);
    } catch {
      setPhase('editing');
      setError(t('providerLogin.qwen.error', {
        defaultValue: 'The credential could not be saved. Check the plan, region, and key, then try again.',
      }));
    }
  };

  if (phase === 'success') {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-5 bg-card p-8 text-center">
        <CheckCircle2 className="h-10 w-10 text-success" aria-hidden="true" />
        <div className="space-y-2">
          <h4 className="text-lg font-semibold text-foreground">
            {t('providerLogin.qwen.successTitle', { defaultValue: 'Qwen is connected' })}
          </h4>
          <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
            {t('providerLogin.qwen.successDescription', {
              defaultValue: 'The encrypted credential will be used on the next Qwen message.',
            })}
          </p>
        </div>
        <button
          ref={doneRef}
          type="button"
          onClick={onClose}
          className="rounded-md bg-foreground px-4 py-2 text-[13px] font-semibold text-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t('providerLogin.qwen.done', { defaultValue: 'Done' })}
        </button>
      </div>
    );
  }

  return (
    <form onSubmit={submit} aria-busy={phase === 'saving'} className="flex h-full min-h-0 flex-col bg-card">
      <div className="border-b border-border bg-muted px-5 py-4">
        <div className="flex items-start gap-3">
          <Terminal className="mt-0.5 h-4 w-4 shrink-0 text-foreground" aria-hidden="true" />
          <div className="space-y-1">
            <p className="font-mono text-[13px] font-semibold text-foreground">QWEN CONNECT</p>
            <p className="text-[13px] leading-relaxed text-muted-foreground">
              {t('providerLogin.qwen.intro', {
                defaultValue: 'Enter the Alibaba Cloud key issued for your Coding Plan or Token Plan. nassaj stores it encrypted for your account.',
              })}
            </p>
          </div>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto p-5">
        <div className="mx-auto max-w-2xl space-y-6">
          <fieldset disabled={phase === 'saving'}>
            <legend className="mb-2 text-[13px] font-semibold text-foreground">
              {t('providerLogin.qwen.planLabel', { defaultValue: 'Plan type' })}
            </legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(['coding_plan', 'token_plan'] as const).map((value) => (
                <label key={value} className="flex cursor-pointer items-center gap-3 rounded-md border border-border p-3 has-[:checked]:border-foreground has-[:checked]:bg-muted">
                  <input
                    type="radio"
                    name="qwen-plan"
                    value={value}
                    checked={plan === value}
                    onChange={() => setPlan(value)}
                    className="accent-primary"
                  />
                  <span className="text-[13px] font-medium text-foreground">
                    {value === 'coding_plan' ? 'Coding Plan' : 'Token Plan'}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <fieldset disabled={phase === 'saving'}>
            <legend className="mb-2 text-[13px] font-semibold text-foreground">
              {t('providerLogin.qwen.regionLabel', { defaultValue: 'Service region' })}
            </legend>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(['international', 'china'] as const).map((value) => (
                <label key={value} className="flex cursor-pointer items-start gap-3 rounded-md border border-border p-3 has-[:checked]:border-foreground has-[:checked]:bg-muted">
                  <input
                    type="radio"
                    name="qwen-region"
                    value={value}
                    checked={region === value}
                    onChange={() => setRegion(value)}
                    className="mt-0.5 accent-primary"
                  />
                  <span className="space-y-0.5 text-[13px]">
                    <span className="block font-medium text-foreground">
                      {value === 'international'
                        ? t('providerLogin.qwen.international', { defaultValue: 'International' })
                        : t('providerLogin.qwen.china', { defaultValue: 'Beijing' })}
                    </span>
                    <span className="block text-muted-foreground">
                      {value === 'international'
                        ? t('providerLogin.qwen.internationalHint', { defaultValue: 'For most accounts outside mainland China' })
                        : t('providerLogin.qwen.chinaHint', { defaultValue: 'For mainland China ModelStudio accounts' })}
                    </span>
                  </span>
                </label>
              ))}
            </div>
          </fieldset>

          <div>
            <label htmlFor="qwen-managed-api-key" className="mb-2 block text-[13px] font-semibold text-foreground">
              {t('providerLogin.qwen.keyLabel', { defaultValue: 'Access key' })}
            </label>
            <input
              id="qwen-managed-api-key"
              type="password"
              dir="ltr"
              autoComplete="off"
              spellCheck={false}
              value={apiKey}
              disabled={phase === 'saving'}
              onChange={(event) => setApiKey(event.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 font-mono text-sm text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60"
            />
            <p className="mt-2 flex items-center gap-2 text-[13px] text-muted-foreground">
              <ShieldCheck className="h-4 w-4 shrink-0" aria-hidden="true" />
              {t('providerLogin.qwen.encrypted', {
                defaultValue: 'Stored in the encrypted nassaj vault; never written to Qwen settings.',
              })}
            </p>
          </div>

          {error && (
            <p ref={errorRef} tabIndex={-1} role="alert" className="rounded-md border border-danger/30 bg-danger/5 p-3 text-[13px] text-danger">
              {error}
            </p>
          )}
        </div>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border px-5 py-4">
        <button type="button" onClick={onClose} disabled={phase === 'saving'} className="rounded-md border border-border px-4 py-2 text-[13px] text-foreground disabled:opacity-60">
          {t('providerLogin.qwen.cancel', { defaultValue: 'Cancel' })}
        </button>
        <button
          type="submit"
          disabled={!plan || !apiKey.trim() || phase === 'saving'}
          className="inline-flex items-center gap-2 rounded-md bg-foreground px-4 py-2 text-[13px] font-semibold text-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {phase === 'saving' && <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />}
          {phase === 'saving'
            ? t('providerLogin.qwen.saving', { defaultValue: 'Saving securely…' })
            : t('providerLogin.qwen.save', { defaultValue: 'Save and connect' })}
        </button>
      </div>
    </form>
  );
}
