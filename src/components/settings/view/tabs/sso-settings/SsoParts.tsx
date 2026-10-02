/**
 * Small building blocks of the SSO tab (brief §3): left-to-right technical
 * islands, the copy field, mapped inline errors and the shared input style.
 * Compositions of existing tokens only; no new colour, radius or type size.
 */
import { useEffect, useId, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, Check, Copy, Loader2 } from 'lucide-react';

import { Button } from '../../../../../shared/view/ui';
import { cn } from '../../../../../lib/utils';
import { copyTextToClipboard } from '../../../../../utils/clipboard';

import { HINT_CLASS, LABEL_CLASS, TECH_INPUT_CLASS, useSsoMessage } from './ssoUi';

/** A technical value (URL, claim, code) as an isolated left-to-right island in the mono face. */
export function Tech({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <bdi dir="ltr" className={cn('break-all font-mono text-[13px]', className)} style={{ unicodeBidi: 'isolate' }}>
      {children}
    </bdi>
  );
}

/** Read-only value with its own copy button at the inline end (brief §3 `CopyField`). */
export function CopyField({ label, value, where }: { label: string; value: string; where?: ReactNode }) {
  const { t } = useTranslation('settings');
  const id = useId();
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return undefined;
    const timer = setTimeout(() => setCopied(false), 2000);
    return () => clearTimeout(timer);
  }, [copied]);

  return (
    <div className="space-y-1.5">
      <label htmlFor={id} className={LABEL_CLASS}>{label}</label>
      <div className="flex items-center gap-2">
        <input id={id} readOnly value={value} dir="ltr" style={{ unicodeBidi: 'isolate' }}
          className={TECH_INPUT_CLASS} aria-describedby={where ? `${id}-where` : undefined}
          onFocus={(event) => event.currentTarget.select()} />
        <Button type="button" variant="outline" size="icon" className="shrink-0"
          aria-label={t('sso.action.copyNamed', { name: label })}
          onClick={() => { void copyTextToClipboard(value).then((ok) => setCopied(ok)); }}>
          {copied ? <Check aria-hidden="true" /> : <Copy aria-hidden="true" />}
        </Button>
      </div>
      {where && <p id={`${id}-where`} className={HINT_CLASS}>{where}</p>}
      <span className="sr-only" aria-live="polite">{copied ? t('sso.action.copied') : ''}</span>
    </div>
  );
}

/** Inline error under the action that failed (brief §11), mapped through §7.3. */
export function SsoError({ code, details, retryAfterSeconds, id }: {
  code: string; details?: Record<string, unknown>; retryAfterSeconds?: number; id?: string;
}) {
  const { t } = useTranslation('settings');
  const message = useSsoMessage()(code, details);
  return (
    <p id={id} role="alert" className="flex items-start gap-1.5 text-[13px] leading-relaxed text-danger">
      <AlertCircle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
      <span className="min-w-0">
        {message.text}
        {retryAfterSeconds ? ` ${t('sso.retryIn', { seconds: retryAfterSeconds })}` : ''}
        {!message.known && <> <Tech>{code}</Tech></>}
      </span>
    </p>
  );
}

/** Spinner + muted line, `role="status"`. */
export function BusyLine({ children }: { children: ReactNode }) {
  return (
    <p role="status" className="flex items-center gap-2 text-[13px] leading-relaxed text-muted-foreground">
      <Loader2 className="h-4 w-4 animate-spin" aria-hidden="true" />
      {children}
    </p>
  );
}
