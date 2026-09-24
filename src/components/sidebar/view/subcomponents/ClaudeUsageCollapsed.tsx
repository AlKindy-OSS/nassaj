import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';

// T-1822: استبدال useClaudeUsage بالمخزن المشترك لتجنّب مضاعفة الطلبات.
import { useClaudeUsageShared as useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsageShared';
import { useAuth } from '../../../auth/context/AuthContext';
import {
  clampUtilization,
  formatPercent,
  formatResetTime,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';
import {
  getProviderCapabilities,
  getProviderDisplayName,
} from '../../../chat/constants/providerCapabilities';
// نفس مصدر المرحلة 1 و2 بالضبط: المزوّد العام كاحتياط، وواصف القدرات كقرار
// للسطح، وعدّاد الدورة المشترك — كي لا يتشعّب هذا السطح عن الهيدر (شرط A1).
import {
  useSelectedActiveModel,
  useSelectedEngineProvider,
  useSelectedProvider,
} from '../../../../stores/selectedProviderStore';
import { useProviderCycles } from '../../../quick-settings-panel/hooks/useProviderCycles';
import { useCycleCountdown } from '../../../quick-settings-panel/hooks/useCycleCountdown';
import { useProviderQuota } from '../../../quick-settings-panel/hooks/useProviderQuota';
import {
  looksLikeAnthropicModel,
  resolveWindowLength,
  shouldSuppressOnProviderWindowsLoading,
} from '../../../quick-settings-panel/providerQuotaHelpers';
import { isolateBidi } from '../../../quick-settings-panel/subscriptionHelpers';

// ---------------------------------------------------------------------------
// useMediaQuery — copied from HeaderUsageIndicator; tracks matchMedia reactively.
// ---------------------------------------------------------------------------
function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(query).matches;
  });

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;

    const mq = window.matchMedia(query);
    const handler = (e: MediaQueryListEvent) => setMatches(e.matches);

    // Sync once on mount in case the value changed between render and effect.
    setMatches(mq.matches);

    if (typeof mq.addEventListener === 'function') {
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    }

    // Fallback for older browsers.
    mq.addListener(handler);
    return () => mq.removeListener(handler);
  }, [query]);

  return matches;
}

type WindowEntry = {
  letter: string;
  key: keyof Pick<
    ClaudeUsage,
    'session' | 'weeklyAllModels' | 'weeklySonnet' | 'weeklyOpus'
  >;
};

const WINDOWS: WindowEntry[] = [
  { letter: 'C', key: 'session' },
  { letter: 'W', key: 'weeklyAllModels' },
  { letter: 'S', key: 'weeklySonnet' },
  { letter: 'O', key: 'weeklyOpus' },
];

type ClaudeUsageCollapsedProps = {
  /**
   * مزوّد الجلسة المفتوحة حالياً (selectedSession?.__provider ?? null).
   * أشرطة الحصة بيانات حساب Claude حصراً ولا تنطبق على أي مزوّد آخر — لذا
   * تُحجَب هذه الأعمدة كلياً حين الجلسة ليست claude (مطابقة HeaderUsageIndicator).
   *
   * غيابه (لا جلسة مفتوحة) لا يعني claude: يُعتمد حينها المنتقي العام، وإلا
   * سقطت القيمة على 'claude' افتراضياً فعُرضت حصّة كلود مع مزوّد آخر — نفس
   * عيب B-310 في الهيدر، وهذا السطح كان يحمله أيضاً.
   */
  sessionProvider?: string | null;
};

/**
 * Collapsed-rail variant for Claude usage windows.
 * Mirrors the style of SystemStatsCollapsed: tiny vertical stacks.
 *
 * Renders only on narrow viewports (<1280px) where HeaderUsageIndicator is
 * hidden. On wide viewports (≥1280px) the header already shows this data, so
 * we return null to avoid duplication. A CSS double-guard (xl:hidden) is also
 * applied to cover any SSR/hydration timing gap.
 *
 * Renders nothing on loading / error / all-null windows, and nothing at all
 * when the open session's provider isn't claude (this is Claude account
 * quota data — it doesn't apply to Codex/other providers).
 */
export function ClaudeUsageCollapsed({ sessionProvider }: ClaudeUsageCollapsedProps) {
  // All hooks must be called unconditionally before any conditional return.
  const { t, i18n } = useTranslation('settings');
  const { user } = useAuth();
  const globalProvider = useSelectedProvider();
  // نفس أسبقية الهيدر: المحرّك قبل الجسم (‏ADR-037) — الفوترة تتبع المحرّك.
  const engineProvider = useSelectedEngineProvider();
  const effectiveProvider = engineProvider ?? sessionProvider ?? globalProvider;
  const activeModel = useSelectedActiveModel();
  const quota = getProviderCapabilities(effectiveProvider).quota;
  // Complementary to HeaderUsageIndicator's (min-width: 1280px) guard.
  const isNarrow = useMediaQuery('(max-width: 1279px)');
  // فرع الدورة لغير كلود — نفس الهوكين اللذين يستهلكهما الهيدر (لا مبلغ، ولا
  // مسح سجلات: ‏/costs/cycle لا /costs/subscriptions).
  // نفس ترتيب الهيدر: نوافذ المزوّد أولاً ثم الدورة ملاذاً (شرط A1 — سطحان من
  // واصف واحد، لا منطق مكرَّر يتشعّب).
  const wantsWindows =
    quota.surface === 'provider-windows' ||
    (quota.surface === 'claude-windows' && Boolean(activeModel));
  const wantsCycle = quota.surface === 'cycle' || quota.surface === 'provider-windows';
  const providerQuota = useProviderQuota(effectiveProvider, activeModel, isNarrow && wantsWindows);
  const quotaWindows = providerQuota.windows;
  // لا نُشغّل fallback أثناء idle/loading؛ ننتظر حكماً نهائياً من مصدر الحصة
  // حتى لا تومض دورة الاشتراك قبل وصول نوافذ Codex/GLM.
  const cycleFallbackResolved =
    quota.surface === 'cycle' ||
    (quota.surface === 'provider-windows' &&
      (providerQuota.status === 'none' ||
        providerQuota.status === 'error' ||
        providerQuota.status === 'anthropic' ||
        (providerQuota.status === 'success' && quotaWindows.length === 0)));
  // نفس قاعدة الهيدر حرفياً (سطحان من مصدر واحد).
  // (B-fix4: لا تفاؤل خلال loading/idle لنماذج مُحدَّدة غير Anthropic).
  const claudeWindowsAllowed =
    quota.isClaudeAccount &&
    engineProvider === null &&
    (!activeModel || providerQuota.isAnthropic || looksLikeAnthropicModel(activeModel));
  const usage = useClaudeUsage(claudeWindowsAllowed, user?.id);
  const cyclesState = useProviderCycles(isNarrow && cycleFallbackResolved);
  const cycle = useCycleCountdown(
    cyclesState.status === 'success' ? cyclesState.rows : null,
    wantsCycle ? effectiveProvider : null,
  );

  // On wide viewports the header already shows usage — skip rendering here.
  if (!isNarrow) return null;

  // غير كلود: دورة التجديد إن كانت مرساتها مُكتشَفة/يدوية، وإلا صمت.
  if (!claudeWindowsAllowed) {
    if (quotaWindows.length > 0) {
      return (
        <>
          <div className="flex flex-col items-center xl:hidden">
            {quotaWindows.map((window) => {
              const percent = formatPercent(clampUtilization(window.usedPercent), i18n.language);
              const horizonText = t(`providerQuota.horizon.${window.horizon.unit}`, {
                count: window.horizon.value,
                value: window.horizon.value,
              });
              // نفس قاعدة الهيدر: الوسم للطول، والأفق في aria/title.
              const length = resolveWindowLength(window.windowSeconds);
              const badgeText = length?.letter ?? (length ? `${length.value ?? ''}d` : '⟳');
              const lengthText = length
                ? t(`providerQuota.length.${length.kind}`, { value: length.value })
                : t('providerQuota.windowGeneric');
              const ariaLabel = `${t('providerQuota.windowGeneric')} · ${lengthText}: ${percent} — ${t(
                'providerQuota.resetsIn',
                { horizon: horizonText },
              )}`;
              return (
                <div
                  key={window.key}
                  className="flex flex-col items-center gap-1 py-1"
                  title={ariaLabel}
                  aria-label={ariaLabel}
                >
                  <span className="text-[10px] font-semibold leading-none text-primary">
                    {badgeText}
                  </span>
                  <span
                    className={`text-[11px] tabular-nums leading-none ${usageTextColorClass(clampUtilization(window.usedPercent))}`}
                  >
                    {percent}
                  </span>
                </div>
              );
            })}
          </div>
        </>
      );
    }

    // ── حالة الخطأ: قراءة الحصّة تعذّرت — نفس منطق الهيدر حرفياً (شرط A1) ──
    // الدورة (إن أُحضرت) تظهر في title/aria كسياق ثانوي، لا كشارة أساسية.
    if (quota.surface === 'provider-windows' && providerQuota.status === 'error') {
      const errorLabel = t('providerQuota.readErrorLabel');
      const errorTooltipText = t('providerQuota.readErrorTooltip', {
        provider: isolateBidi(getProviderDisplayName(effectiveProvider)),
      });
      const cycleHint = cycle
        ? ` (${t('providerCycle.renewsIn', { days: cycle.daysRemaining })})`
        : '';
      return (
        <>
          <div className="flex flex-col items-center xl:hidden">
            <div
              className="flex flex-col items-center gap-1 py-1"
              title={`${errorTooltipText}${cycleHint}`}
              aria-label={errorLabel}
              data-testid="provider-quota-error-badge"
            >
              <span
                className="text-[10px] font-semibold leading-none text-muted-foreground opacity-60"
                aria-hidden="true"
              >
                ⚠
              </span>
            </div>
          </div>
        </>
      );
    }

    // ── حارس الوميض أثناء إعادة المحاولة (B-1290 follow-up) ─────────────────
    // نفس المنطق المشترك مع الهيدر — helper نقية واحدة للسطحين.
    if (shouldSuppressOnProviderWindowsLoading(quota.surface, providerQuota.status)) return null;

    if (!cycle) return null;
    const renewsInText = t('providerCycle.renewsIn', { days: cycle.daysRemaining });
    const ariaLabel = `${t('providerCycle.title')}: ${renewsInText}`;
    return (
      <>
        <div className="flex flex-col items-center xl:hidden">
          <div
            className="flex flex-col items-center gap-1 py-1"
            title={ariaLabel}
            aria-label={ariaLabel}
          >
            <span className="text-xs font-semibold leading-none text-primary" aria-hidden="true">
              ↻
            </span>
            <span className="text-[11px] tabular-nums leading-none text-muted-foreground">
              {t('providerCycle.compact', { days: cycle.daysRemaining })}
            </span>
          </div>
        </div>
      </>
    );
  }

  if (usage.status !== 'success') return null;
  const { data } = usage;

  const visible = WINDOWS.filter(({ key }) => data[key] !== null);
  if (visible.length === 0) return null;

  return (
    // CSS double-guard: JS hides on wide viewports; xl:hidden covers any
    // SSR/hydration timing gap. flex flex-col items-center matches the
    // surrounding rail layout so the div is transparent to positioning.
    <>
    <div className="flex flex-col items-center xl:hidden">
      {visible.map(({ letter, key }) => {
        const window = data[key]!;
        const clamped = clampUtilization(window.utilization);
        const percent = formatPercent(clamped, i18n.language);
        const windowLabel = t(`claudeUsage.windows.${key}`);
        const resetText = formatResetTime(window.resetsAt, i18n.language);
        const resetSuffix = resetText
          ? ` — ${t('claudeUsage.resetsIn', { time: resetText })}`
          : '';
        const ariaLabel = `${windowLabel}: ${percent}${resetSuffix}`;

        return (
          <div
            key={key}
            className="flex flex-col items-center gap-1 py-1"
            title={ariaLabel}
            aria-label={ariaLabel}
          >
            <span className="text-xs font-semibold leading-none text-primary">
              {letter}
            </span>
            <span
              className={`text-[11px] tabular-nums leading-none ${usageTextColorClass(clamped)}`}
            >
              {percent}
            </span>
          </div>
        );
      })}
    </div>
    </>
  );
}
