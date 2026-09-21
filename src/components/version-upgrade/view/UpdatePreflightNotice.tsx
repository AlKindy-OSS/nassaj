import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { AlertCircle, CheckCircle2, Clock, Loader2 } from 'lucide-react';

import { copyTextToClipboard } from '../../../utils/clipboard';
import { localizeBlocker, type PreflightState } from '../updatePreflightClient';

interface UpdatePreflightNoticeProps {
  state: PreflightState;
  /** Re-run the pre-flight after the owner has acted on the reported cause. */
  onRecheck: () => void;
}

const RECHECK_CLASS = 'mt-2 rounded-md border border-current/30 px-2.5 py-1 text-xs font-medium hover:bg-black/5 dark:hover:bg-white/10';

/**
 * The pre-flight verdict inside the update modal (ADR-156 أ.5): one cause and
 * one action, never a list. Logical properties only, so it reads correctly in
 * Arabic and English alike; the operator command stays LTR inside RTL text.
 */
export function UpdatePreflightNotice({ state, onRecheck }: UpdatePreflightNoticeProps) {
  const { t, i18n } = useTranslation('common');
  const [copied, setCopied] = useState(false);

  if (state.status === 'idle') return null;

  if (state.status === 'checking') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        <Loader2 aria-hidden="true" className="h-4 w-4 shrink-0 animate-spin motion-reduce:animate-none" />
        <span>{t('versionUpdate.preflight.checking')}</span>
      </div>
    );
  }

  if (state.status === 'clear') {
    return (
      <div role="status" className="flex items-center gap-2 rounded-md border border-border bg-muted px-3 py-2 text-xs text-muted-foreground">
        <CheckCircle2 aria-hidden="true" className="h-4 w-4 shrink-0 text-green-600 dark:text-green-400" />
        <span>{t('versionUpdate.preflight.clear')}</span>
      </div>
    );
  }

  if (state.status === 'rate_limited') {
    return (
      <div role="status" className="rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-200">
        <p className="flex items-start gap-2">
          <Clock aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>
            {state.retryAfterSeconds
              ? t('versionUpdate.preflight.rateLimitedSeconds', { seconds: state.retryAfterSeconds })
              : t('versionUpdate.preflight.rateLimited')}
          </span>
        </p>
        <button type="button" onClick={onRecheck} className={RECHECK_CLASS}>{t('versionUpdate.preflight.recheck')}</button>
      </div>
    );
  }

  if (state.status === 'error') {
    return (
      <div role="alert" className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
        <p className="flex items-start gap-2">
          <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
          <span>{t(`versionUpdate.preflight.errors.${state.reason}`)}</span>
        </p>
        <button type="button" onClick={onRecheck} className={RECHECK_CLASS}>{t('versionUpdate.preflight.recheck')}</button>
      </div>
    );
  }

  const { reason, action } = localizeBlocker(state.blocker, i18n?.language);
  const { command } = state.blocker;
  const copyCommand = async () => {
    if (command && await copyTextToClipboard(command)) setCopied(true);
  };

  return (
    <div role="alert" className="rounded-md border border-s-4 border-amber-300 border-s-amber-500 bg-amber-50 px-3 py-2 text-start text-xs text-amber-900 dark:border-amber-900/50 dark:border-s-amber-500 dark:bg-amber-950/30 dark:text-amber-200">
      <p className="flex items-start gap-2 font-semibold">
        <AlertCircle aria-hidden="true" className="mt-0.5 h-4 w-4 shrink-0" />
        <span>{t('versionUpdate.preflight.blockedTitle')}</span>
      </p>
      <p className="mt-1 ps-6"><bdi>{reason ?? t('versionUpdate.preflight.fallbackReason')}</bdi></p>
      <p className="mt-1 ps-6">
        <span className="font-medium">{t('versionUpdate.preflight.actionLabel')} </span>
        <bdi>{action ?? t('versionUpdate.preflight.fallbackAction')}</bdi>
      </p>
      {command && (
        <div className="mt-2 flex flex-wrap items-center gap-2 ps-6">
          {/* Wraps rather than scrolls, so a long command is never cut short. */}
          <code dir="ltr" className="min-w-0 flex-1 whitespace-normal rounded bg-amber-100/80 px-2 py-1 text-start font-mono text-[11px] leading-snug [overflow-wrap:anywhere] dark:bg-amber-900/40">
            {command}
          </code>
          <button
            type="button"
            onClick={() => void copyCommand()}
            aria-label={t('versionUpdate.preflight.copyCommandAria')}
            className="shrink-0 rounded-md border border-current/30 px-2 py-1 text-[11px] font-medium hover:bg-black/5 dark:hover:bg-white/10"
          >
            {copied ? t('versionUpdate.preflight.copied') : t('versionUpdate.buttons.copyCommand')}
          </button>
        </div>
      )}
      <div className="ps-6">
        <button type="button" onClick={onRecheck} className={RECHECK_CLASS}>{t('versionUpdate.preflight.recheck')}</button>
      </div>
    </div>
  );
}
