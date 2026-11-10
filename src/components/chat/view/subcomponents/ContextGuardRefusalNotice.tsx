import { useId } from 'react';
import { Trans, useTranslation } from 'react-i18next';
import { Minimize2, TriangleAlert, Undo2 } from 'lucide-react';

import { formatGuardTokens, type ContextGuardInfo } from '../../utils/contextGuard';

type ContextGuardRefusalNoticeProps = {
  info: ContextGuardInfo;
  /** Pins `previousModel` again; absent → no switch-back action. */
  onSwitchBack?: (model: string) => void;
  /** Puts `/compact` in the composer; shown only when `info.canCompactOnPrevious`. */
  onCompact?: () => void;
  className?: string;
};

const ACTION_CLASS = 'inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/60 '
  + 'px-2 py-1 text-xs font-medium text-foreground hover:bg-accent '
  + 'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring';

/** Numbers and model ids are isolated so the Arabic sentence keeps its order. */
const ISOLATES = {
  n: <bdi className="font-medium tabular-nums text-foreground" />,
  m: <bdi className="whitespace-nowrap font-mono text-[12px] text-foreground" />,
};

/**
 * A turn refused because the pinned model cannot hold the conversation
 * (T-2087, ADR-223). Copy comes from the payload in the UI language, never the
 * server sentence; the message itself stays in the outbox card around it.
 */
export default function ContextGuardRefusalNotice({
  info, onSwitchBack, onCompact, className = '',
}: ContextGuardRefusalNoticeProps) {
  const { t } = useTranslation('chat');
  const titleId = useId();
  const previousModel = info.previousModel && info.previousModel !== info.model ? info.previousModel : null;
  const compact = info.canCompactOnPrevious ? onCompact : undefined;
  // The body names only the ways out the card actually offers.
  const bodyKey = info.canCompactOnPrevious
    ? (previousModel ? 'contextGuard.refused.body' : 'contextGuard.refused.bodyNoPrevious')
    : (previousModel ? 'contextGuard.refused.bodyNoCompact' : 'contextGuard.refused.bodyNoPreviousNoCompact');
  const values = {
    used: formatGuardTokens(info.used),
    budget: formatGuardTokens(info.budget),
    model: info.model,
    previousModel: previousModel ?? '',
  };

  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      data-testid="context-guard-refusal"
      className={`rounded-lg border border-warning/30 bg-warning/10 px-3 py-2 text-sm text-foreground ${className}`}
    >
      <p id={titleId} className="flex items-start gap-2 font-medium">
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0 text-warning" aria-hidden="true" />
        <span className="min-w-0 flex-1 break-words">{t('contextGuard.refused.title')}</span>
      </p>
      <p className="mt-1 break-words ps-6 text-[13px] leading-relaxed text-muted-foreground">
        <Trans
          t={t}
          i18nKey={bodyKey}
          values={values}
          components={ISOLATES}
        />
      </p>
      {(onSwitchBack && previousModel) || compact ? (
        <div className="mt-2 flex flex-wrap items-center gap-2 ps-6">
          {onSwitchBack && previousModel && (
            <button type="button" className={ACTION_CLASS} onClick={() => onSwitchBack(previousModel)}>
              <Undo2 className="h-4 w-4 rtl:-scale-x-100" aria-hidden="true" />
              <span>
                <Trans t={t} i18nKey="contextGuard.actions.switchBack" values={{ model: previousModel }} components={ISOLATES} />
              </span>
            </button>
          )}
          {compact && (
            <button
              type="button"
              className={ACTION_CLASS}
              onClick={compact}
              title={t('contextGuard.actions.compactHint')}
            >
              <Minimize2 className="h-4 w-4" aria-hidden="true" />
              {t('contextGuard.actions.compact')}
            </button>
          )}
        </div>
      ) : null}
    </div>
  );
}
