/**
 * PercentMeter — a compact "NN%" readout with an optional thin bar, shared by the
 * main status bar and the sub-agent card so the two never drift apart.
 *
 * `declared` marks a value the AGENT reported about itself (not computed from a
 * TodoWrite list or a tool_result): it gets a dashed outline plus a tooltip /
 * aria suffix saying so. Logical properties only; the bar fills from the inline
 * start, so it mirrors under RTL by itself.
 */

import { useTranslation } from 'react-i18next';

import { cn } from '../../../../lib/utils';

/** Locale-aware whole-number percent, e.g. 40 -> "40%" (en) / "٤٠٪" (ar). */
export function formatPercent(percent: number, locale: string): string {
  return new Intl.NumberFormat(locale, { style: 'percent', maximumFractionDigits: 0 }).format(
    percent / 100,
  );
}

interface PercentMeterProps {
  percent: number;
  /** True when the value is agent-reported rather than computed. */
  declared: boolean;
  /** Accessible name of the bar, e.g. "Overall progress". */
  label: string;
  /** Show the bar from the `sm` breakpoint up only (keeps phones uncluttered). */
  barFromSm?: boolean;
  /** Bar width utility, e.g. `w-10`. */
  barWidth?: string;
  className?: string;
  testId?: string;
}

export default function PercentMeter({
  percent,
  declared,
  label,
  barFromSm = false,
  barWidth = 'w-10',
  className,
  testId,
}: PercentMeterProps) {
  const { t, i18n } = useTranslation('chat');
  const text = formatPercent(percent, i18n.language);
  const declaredNote = t('runProgress.declaredNote', {
    defaultValue: 'Reported by the agent',
  });
  const fullLabel = declared ? `${label} — ${declaredNote}` : label;

  return (
    <span
      data-testid={testId}
      data-declared={declared ? 'true' : 'false'}
      title={fullLabel}
      className={cn(
        'inline-flex min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 py-px',
        'text-[10px] font-medium tabular-nums',
        declared
          ? 'border border-dashed border-violet-500/50 text-violet-700 dark:text-violet-300'
          : 'text-muted-foreground',
        className,
      )}
    >
      <span>{text}</span>
      {/* The bar is hidden under sm; keep the declared wording for screen readers. */}
      {declared && <span className="sr-only">{declaredNote}</span>}
      <span
        className={cn(
          'h-1 shrink-0 overflow-hidden rounded-full bg-border/60',
          barWidth,
          barFromSm && 'hidden sm:block',
        )}
        role="progressbar"
        aria-valuenow={percent}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuetext={declared ? `${text} — ${declaredNote}` : text}
        aria-label={fullLabel}
      >
        <span
          className={cn(
            'block h-full rounded-full transition-[width] duration-500 ease-out',
            declared ? 'bg-violet-500' : 'bg-emerald-500',
          )}
          style={{ width: `${percent}%` }}
        />
      </span>
    </span>
  );
}
