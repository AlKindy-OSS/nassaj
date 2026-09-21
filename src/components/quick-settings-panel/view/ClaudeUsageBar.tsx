import { useTranslation } from 'react-i18next';
import {
  clampUtilization,
  formatPercent,
  formatResetTime,
  usageBarColorClass,
} from '../claudeUsageHelpers';

type ClaudeUsageBarProps = {
  label: string;
  utilization: number;
  resetsAt: string | null;
};

/**
 * A single usage window: label + colored progress bar + percentage + reset hint.
 * Presentational only. Uses logical properties / flex so it mirrors under RTL.
 */
export default function ClaudeUsageBar({
  label,
  utilization,
  resetsAt,
}: ClaudeUsageBarProps) {
  const { t, i18n } = useTranslation('settings');
  const locale = i18n.language;
  const value = clampUtilization(utilization);
  const percentLabel = formatPercent(value, locale);
  const resetText = formatResetTime(resetsAt, locale);

  return (
    <div className="space-y-1">
      <div className="flex items-center justify-between gap-2">
        <span className="text-sm text-foreground">{label}</span>
        <span className="text-xs font-medium tabular-nums text-muted-foreground">
          {t('claudeUsage.percentUsed', { percent: percentLabel })}
        </span>
      </div>
      <div
        className="h-2 w-full overflow-hidden rounded-full bg-muted"
        role="progressbar"
        aria-label={label}
        aria-valuenow={Math.round(value)}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className={`h-full rounded-full transition-[width] duration-300 ${usageBarColorClass(value)}`}
          style={{ width: `${value}%` }}
        />
      </div>
      {resetText && (
        <p className="text-xs text-muted-foreground">
          {t('claudeUsage.resetsIn', { time: resetText })}
        </p>
      )}
    </div>
  );
}
