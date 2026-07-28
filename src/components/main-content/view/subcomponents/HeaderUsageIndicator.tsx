import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
import { useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsage';
import {
  clampUtilization,
  formatPercent,
  formatResetTime,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';
import { getProviderCapabilities } from '../../../chat/constants/providerCapabilities';

// ---------------------------------------------------------------------------
// Window definitions — order determines display order.
// ---------------------------------------------------------------------------
type WindowKey = keyof Pick<
  ClaudeUsage,
  'session' | 'weeklyAllModels' | 'weeklySonnet' | 'weeklyOpus'
>;

const WINDOWS: { letter: string; key: WindowKey }[] = [
  { letter: 'C', key: 'session' },
  { letter: 'W', key: 'weeklyAllModels' },
  { letter: 'S', key: 'weeklySonnet' },
  { letter: 'O', key: 'weeklyOpus' },
];

// ---------------------------------------------------------------------------
// HeaderUsageIndicator
// ---------------------------------------------------------------------------
interface HeaderUsageIndicatorProps {
  tabsMode?: 'full' | 'compact' | 'minimal' | 'hidden';
  /**
   * مزوّد الجلسة المفتوحة حالياً (selectedSession?.__provider). أشرطة الحصة
   * بيانات حساب Claude حصراً ولا تنطبق على أي مزوّد آخر (لا بديل headless
   * لحصص Codex مثلاً، T-905) — لذا يُحجَب المؤشّر كلياً حين الجلسة ليست
   * claude، بدل عرضه موسوماً (تعديل على T-5/T-904).
   */
  sessionProvider?: string | null;
}

export default function HeaderUsageIndicator({ tabsMode, sessionProvider }: HeaderUsageIndicatorProps) {
  const { i18n, t } = useTranslation('settings');
  const isClaudeSession = getProviderCapabilities(sessionProvider).quota.isClaudeAccount;

  // Visible at any viewport width in every mode except "hidden". A previous
  // version gated this on a 900px/1280px width query to protect room for the
  // tab bar, but that guard fired regardless of tabsMode — including on
  // mobile, where the indicator disappeared even though the tab bar itself
  // scrolls/truncates on narrow screens instead of needing the guard. The tab
  // bar's own layout (overflow-x-auto) handles narrow viewports; the indicator
  // no longer needs a width gate of its own.
  const isWide = tabsMode !== 'hidden';

  // Hooks must run unconditionally (rules-of-hooks); gate the hook's argument
  // so it stops polling for non-claude sessions instead of gating the call site.
  const usageState = useClaudeUsage(isWide && isClaudeSession);

  // Claude account usage doesn't apply to non-claude sessions — hide entirely
  // rather than show it with a disambiguation note (T-5/T-904 superseded).
  if (!isClaudeSession) return null;

  // "hidden" mode is the only mode that suppresses the indicator (together
  // with the tab bar). full/compact/minimal all keep it visible regardless of
  // viewport width — the tab bar itself scrolls/truncates on narrow screens
  // instead of the indicator being width-gated.
  if (tabsMode === 'hidden') return null;

  // Silent during loading / error — keep the header clean.
  if (usageState.status !== 'success') return null;

  const { data } = usageState;

  // Build the list of windows that actually have data.
  const items = WINDOWS.flatMap(({ letter, key }) => {
    const win = data[key];
    if (win === null) return [];
    const clamped = clampUtilization(win.utilization);
    return [{ letter, clamped, resetsAt: win.resetsAt }];
  });

  // Nothing to show — all windows are null.
  if (items.length === 0) return null;

  return (
    <div
      className="flex flex-shrink-0 select-none items-center gap-3"
      aria-label={t('claudeUsage.title')}
    >
      {items.map(({ letter, clamped, resetsAt }) => {
        const percent = formatPercent(clamped, i18n.language);
        const colorClass = usageTextColorClass(clamped);
        // Resolve the human-readable window label for aria/title.
        const windowKey = WINDOWS.find((w) => w.letter === letter)!.key;
        const label = t(`claudeUsage.windows.${windowKey}`);
        const resetText = formatResetTime(resetsAt, i18n.language);
        // aria-label carries both the percentage and optional reset time so
        // screen-reader users receive the full context (the percentage is
        // visually rendered but the tooltip alone omits it when no reset time
        // is present, and even with it the percentage is buried).
        const ariaLabel = resetText
          ? `${label}: ${percent} — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : `${label}: ${percent}`;

        // Structured tooltip content with real line breaks — the `title`
        // attribute doesn't support multi-line display on desktop and is
        // invisible on touch. Tooltip with tapToToggle handles both.
        const tooltipContent = (
          <div className="space-y-0.5">
            <div className="font-medium">{label}</div>
            <div className="opacity-75">{percent}</div>
            {resetText && (
              <div className="opacity-75">{t('claudeUsage.resetsIn', { time: resetText })}</div>
            )}
          </div>
        );

        return (
          <Tooltip
            key={letter}
            content={tooltipContent}
            position="bottom"
            tapToToggle
            multiline
          >
            <span
              className="flex items-baseline gap-0.5 text-xs"
              aria-label={ariaLabel}
            >
              <span className="font-semibold text-primary">{letter}</span>
              <span className={`tabular-nums ${colorClass}`}>{percent}</span>
            </span>
          </Tooltip>
        );
      })}
    </div>
  );
}
