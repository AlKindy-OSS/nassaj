import { useTranslation } from 'react-i18next';

import { Tooltip } from '../../../../shared/view/ui';
// T-1822: استبدال useClaudeUsage بالمخزن المشترك لتجنّب مضاعفة الطلبات.
import { useClaudeUsageShared as useClaudeUsage } from '../../../quick-settings-panel/hooks/useClaudeUsageShared';
import { useAuth } from '../../../auth/context/AuthContext';
import {
  clampUtilization,
  formatCreditBalance,
  formatCredits,
  formatPercent,
  formatRemainingHarnessCredits,
  formatResetTime,
  hasDisplayableExtraUsageCredits,
  usageTextColorClass,
} from '../../../quick-settings-panel/claudeUsageHelpers';
import type { ClaudeUsage } from '../../../quick-settings-panel/claudeUsageTypes';
import {
  getProviderCapabilities,
  getProviderDisplayName,
} from '../../../chat/constants/providerCapabilities';
// المزوّد العام كاحتياط حين لا توجد جلسة مفتوحة — لئلاّ تسقط القيمة على 'claude'
// افتراضياً فتُعرض حصّة كلود مع منتقٍّ غير كلود.
import {
  useSelectedActiveModel,
  useSelectedEngineProvider,
  useSelectedProvider,
} from '../../../../stores/selectedProviderStore';
import { useProviderCycles } from '../../../quick-settings-panel/hooks/useProviderCycles';
import { useCycleCountdown } from '../../../quick-settings-panel/hooks/useCycleCountdown';
import { isolateBidi } from '../../../quick-settings-panel/subscriptionHelpers';
import {
  quotaCountdownParts,
  selectActiveQuotaBlock,
} from '../../../quick-settings-panel/quotaBlockHelpers';
import { useProviderQuota } from '../../../quick-settings-panel/hooks/useProviderQuota';
import {
  looksLikeAnthropicModel,
  resolveWindowLength,
  shouldSuppressOnProviderWindowsLoading,
} from '../../../quick-settings-panel/providerQuotaHelpers';

// ---------------------------------------------------------------------------
// QuotaErrorBadge — خالصة بلا hooks، تعرض حالة تعذّر القراءة.
// مفصولة عن المكوّن الأب لتبقى ≤50 سطراً وعمقاً ≤3 (قاعدة التنظيف).
// ---------------------------------------------------------------------------
interface QuotaErrorBadgeProps {
  /** نصّ قصير لـ aria-label والسطر الأول من التلميح. */
  errorLabel: string;
  /** وصف سبب التعذّر للتلميح (اسم المزوّد مُضمَّن). */
  errorTooltipText: string;
  /** معلومة التجديد الثانوية — تُعرض في نهاية التلميح كسياق لا كشارة أساسية. */
  cycleSecondaryText: string | null;
}

/**
 * شارة مكتومة تُشير إلى تعذّر قراءة حصّة المزوّد — لا تُظهر رقم الدورة
 * كشارة أساسية. الدورة (إن كانت) تظهر فقط في نهاية التلميح.
 */
function QuotaErrorBadge({ errorLabel, errorTooltipText, cycleSecondaryText }: QuotaErrorBadgeProps) {
  const tooltip = (
    <div className="space-y-0.5">
      <div className="font-medium">{errorLabel}</div>
      <div className="opacity-75">{errorTooltipText}</div>
      {cycleSecondaryText && (
        <div className="opacity-50 mt-0.5">{cycleSecondaryText}</div>
      )}
    </div>
  );
  return (
    <div
      className="flex flex-shrink-0 select-none items-center"
      aria-label={errorLabel}
      data-testid="provider-quota-error-badge"
    >
      <Tooltip content={tooltip} position="bottom" tapToToggle multiline>
        <span className="flex items-baseline text-xs" aria-hidden="true">
          <span className="font-semibold text-muted-foreground opacity-60" aria-hidden="true">
            ⚠
          </span>
        </span>
      </Tooltip>
    </div>
  );
}

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
   * مزوّد الجلسة المفتوحة حالياً (selectedSession?.__provider). أشرطة C/W/S/O
   * بيانات حساب Claude حصراً، فتُحجَب حين الجلسة ليست claude بدل عرضها موسومة
   * (تعديل على T-5/T-904).
   *
   * وما كان مسجَّلاً في T-905 من أن «لا بديل headless لحصص كودكس» **منقوضٌ
   * بجولة توثيق 2026-07-30**: لكودكس وglm نقطتا حصّة رسميتان تُقرآن خادمياً،
   * فيعرض كلٌّ منهما نوافذه (`surface: 'provider-windows'`).
   *
   * قد يكون `null`/`undefined` حين لا جلسة مفتوحة (أو جلسة جديدة قبل ختمها)،
   * وحينها يُعتمد المزوّد العام من المنتقي بدلاً منه.
   */
  sessionProvider?: string | null;
}

export default function HeaderUsageIndicator({ tabsMode, sessionProvider }: HeaderUsageIndicatorProps) {
  const { i18n, t } = useTranslation('settings');
  const { user } = useAuth();
  // النمط الكانوني في التطبيق: مزوّد الجلسة المفتوحة أولاً، وإلا المنتقي العام
  // (ChatInterface.tsx / useChatProviderState). بلا هذا الاحتياط كانت القيمة
  // تسقط على 'claude' افتراضياً داخل getProviderCapabilities عند غياب الجلسة،
  // فتظهر حصّة كلود مع منتقٍّ غير كلود.
  const globalProvider = useSelectedProvider();
  // محور المحرّك يتقدّم على محور الجسم في كل ما يتعلّق بالحصّة (‏ADR-037):
  // جلسة جسمها `claude` ومحرّكها `glm` تُفوتَر توكنزها على z.ai لا على اشتراك
  // Anthropic، فعرض C/W/S/O عليها رقمٌ لا علاقة له بما يُستهلك (بلاغ المالك
  // 2026-07-30 بلقطة: «C 0% W 0%» على جلسة تعمل على glm-5.2).
  const engineProvider = useSelectedEngineProvider();
  const effectiveProvider = engineProvider ?? sessionProvider ?? globalProvider;
  const quota = getProviderCapabilities(effectiveProvider).quota;
  // النموذج الفعّال: الدليل المستقلّ عن الجهاز على محور المحرّك. ختم المحرّك
  // أعلاه محليّ لكل متصفّح (لا يُحفَظ خادمياً)، فالمالك على جهاز آخر لا ختم
  // عنده — والنموذج يصله من الخادم فيحسم المورّد هناك (`resolveModelVendor`).
  const activeModel = useSelectedActiveModel();

  // Visible at any viewport width in every mode except "hidden". A previous
  // version gated this on a 900px/1280px width query to protect room for the
  // tab bar, but that guard fired regardless of tabsMode — including on
  // mobile, where the indicator disappeared even though the tab bar itself
  // scrolls/truncates on narrow screens instead of needing the guard. The tab
  // bar's own layout (overflow-x-auto) handles narrow viewports; the indicator
  // no longer needs a width gate of its own.
  const isWide = tabsMode !== 'hidden';

  // المزوّد غير الكلودي: دورة التجديد بدل الصمت — بشرط أن يرسل الخادم صفّاً
  // بمرساة مُكتشَفة/يدوية. الهوك هنا ليس `useSubscriptionCosts`: هذا لا يقرأ
  // سجلاً واحداً (‏742ms بارداً/‏0ms دافئاً مقابل ~14ث)، وهو الشرط الذي جعل
  // وصلَ سطحٍ دائم الظهور مقبولاً أصلاً. ولا مبلغ في أي فرع — العقد لا يحمله.
  // نوافذ المزوّد أولاً (المصدر الرسمي عنده)، ودورة التجديد ملاذاً حين يتعذّر
  // ذلك المصدر — وهي حالةٌ واقعية قِستُها: توكن كودكس المعزول لهذا الحساب
  // منتهٍ منذ 2026-07-21، فالنداء الحيّ 401 ⇒ يظهر «↻ 12ي» من المرساة
  // المُكتشَفة بدل الصمت. ولا رقم مختلق في أيّ من الحالتين.
  // نحاول المصدر الرسمي لأي مزوّد له سطح — بما فيه جسم `claude` حين يحمل
  // نموذجاً لمورّد آخر (فيرد الخادم بمورّد ذلك النموذج). و`none` وحده لا يُحاول.
  const wantsWindows =
    quota.surface === 'provider-windows' ||
    (quota.surface === 'claude-windows' && Boolean(activeModel));
  const wantsCycle = quota.surface === 'cycle' || quota.surface === 'provider-windows';
  const providerQuota = useProviderQuota(effectiveProvider, activeModel, isWide && wantsWindows);
  const quotaWindows = providerQuota.windows;
  // سطح الدورة الخالص لا ينتظر مصدراً غير موجود. أمّا provider-windows فلا
  // يسقط إلى الدورة حتى يُحسم الطلب: none/error، أو success بلا نافذة صالحة
  // (ومنها حمولة كل نوافذها منتهية). idle/loading يبقيان صامتين لمنع الوميض.
  const cycleFallbackResolved =
    quota.surface === 'cycle' ||
    (quota.surface === 'provider-windows' &&
      (providerQuota.status === 'none' ||
        providerQuota.status === 'error' ||
        providerQuota.status === 'anthropic' ||
        (providerQuota.status === 'success' && quotaWindows.length === 0)));
  // نوافذ حساب Claude تُعرض حين: الواصف يقول claude، **و**لا محرّك مختوم،
  // **و**لم يُثبِت الخادم أن النموذج الفعّال يُفوتَر على مورّد آخر. وحين يكون
  // النموذج معروفاً ننتظر حكم الخادم بدل عرض رقمٍ قد يكون لحسابٍ آخر —
  // الصمت لحظةً أصدق من نسبة تخصّ اشتراكاً لا يُستهلك منه شيء.
  // (B-fix4: لا تفاؤل خلال loading/idle لنماذج مُحدَّدة غير Anthropic — glm وما شابه).
  const claudeWindowsAllowed =
    quota.isClaudeAccount &&
    engineProvider === null &&
    (!activeModel || providerQuota.isAnthropic || looksLikeAnthropicModel(activeModel));

  // Hooks must run unconditionally (rules-of-hooks); gate the hook's argument
  // so it stops polling when Claude windows don't apply, instead of gating the
  // call site. **يجب أن يأتي بعد `claudeWindowsAllowed`**: النسخة الأولى نادته
  // قبل تعريفه فسقط typecheck — والترتيب هنا شرطُ صحّة لا ذوقاً.
  // qa-critic (T-1858, جولة 2): كان يُشغَّل أيضاً حين effectiveProvider==='codex'
  // ليُعرض «رصيد هارنس Claude الإضافي» بجانب رصيد Codex — بشارة «+» غير
  // موسومة تحمل معنيين مختلفين على حساب قد لا يكون حتى حساب Claude. حُصر
  // بـ`claudeWindowsAllowed` (يتضمّن `quota.isClaudeAccount`) كما كان: جلسة
  // Codex تُظهر رصيد Codex فقط.
  const usageState = useClaudeUsage(isWide && claudeWindowsAllowed, user?.id);
  const cyclesState = useProviderCycles(isWide && cycleFallbackResolved);
  const cycle = useCycleCountdown(
    cyclesState.status === 'success' ? cyclesState.rows : null,
    wantsCycle ? effectiveProvider : null,
  );

  // T-1191: حصار الحصة يركب نفس حمولة الدورة، فلا طلب إضافي ولا استقصاء.
  // `Date.now()` يُقرأ عند التركيب فقط — لا مؤقّت يُحدّث العدّاد كل ثانية:
  // الدقّة المعروضة يوم/ساعة/دقيقة، ومؤقّتٌ يُعيد التركيب لتغيير رقمٍ يتحرّك
  // مرّة في الساعة كلفةٌ بلا مقابل. يُصحَّح عند أول إعادة تحميل أو تبديل مزوّد.
  const quotaBlock = selectActiveQuotaBlock(
    cyclesState.status === 'success' ? cyclesState.quotaBlocks : null,
    wantsCycle ? effectiveProvider : null,
    Date.now(),
  );

  // "hidden" mode is the only mode that suppresses the indicator (together
  // with the tab bar). full/compact/minimal all keep it visible regardless of
  // viewport width — the tab bar itself scrolls/truncates on narrow screens
  // instead of the indicator being width-gated.
  if (tabsMode === 'hidden') return null;

  // ── فرع غير كلود: دورة التجديد أو الصمت ──────────────────────────────────
  // ثلاث حالات تُخفي كلها بصدق (القرار في `providerCycleHelpers` النقية): لا
  // صفّ لهذا المزوّد (غير مُصادَق عليه أو أخفاه المالك)، أو مرساة
  // `unknown`/`derived` (شهر تقويمي مفترَض ⇒ موعدٌ مختلق لو عُرض)، أو دورة
  // انتهت قبل أن يُحدَّث الجلب. الخطأ يُظهر الشارة المخصّصة لا شارة الدورة.
  // idle/loading يبقيان صامتَين بواسطة `shouldSuppressOnProviderWindowsLoading`.
  if (!claudeWindowsAllowed) {
    // ── نوافذ المزوّد (نسبة مستهلكة + أفق التصفير) ──────────────────────────
    const extraCredits =
      providerQuota.status === 'success' ? providerQuota.data?.extraUsageCredits : undefined;
    const hasExtraCredits =
      extraCredits &&
      Number.isFinite(extraCredits.balance) &&
      extraCredits.balance >= 0 &&
      typeof extraCredits.unlimited === 'boolean';
    const extraCreditsLabel =
      hasExtraCredits && extraCredits
        ? extraCredits.unlimited
          ? t('agentUsage.unlimited')
          : t('agentUsage.creditUnits', {
              formattedCount: isolateBidi(formatCreditBalance(extraCredits.balance, i18n.language)),
            })
        : null;

    if (quotaWindows.length > 0 || hasExtraCredits) {
      return (
        <div
          className="flex flex-shrink-0 select-none items-center gap-3"
          aria-label={t('providerQuota.title')}
        >
          {quotaWindows.map((window) => {
            const percent = formatPercent(clampUtilization(window.usedPercent), i18n.language);
            const horizonText = t(`providerQuota.horizon.${window.horizon.unit}`, {
              count: window.horizon.value,
              value: window.horizon.value,
            });
            // الشارة تحمل **طول النافذة** (5س/أسبوع/شهر) لا موعد تصفيرها: الوسم
            // بالأفق كان يُقرأ طولاً («7س 29%» عن النافذة الأسبوعية) — وهو ما
            // بلّغ عنه المالك. والأفق انتقل إلى التلميح حيث يُقال بجملة كاملة.
            const length = resolveWindowLength(window.windowSeconds);
            // الحرف الموحَّد على كل المزوّدات (‏C/W/M — نفس حروف نوافذ كلود)،
            // وطولٌ غير قياسي يُوسَم بعدده. والوصف الكامل يذهب للتلميح.
            const badgeText = length?.letter ?? (length ? `${length.value ?? ''}d` : '⟳');
            const lengthText = length
              ? t(`providerQuota.length.${length.kind}`, { value: length.value })
              : t('providerQuota.windowGeneric');
            // اسم المزوّد في التلميح: شارةٌ تقول «5س 1%» وحدها لا تُخبر **حصّة
            // مَن**، والمالك يفتح الجلسة نفسها على مزوّدات مختلفة.
            const windowLabel = length
              ? `${getProviderDisplayName(effectiveProvider)} · ${t('providerQuota.windowGeneric')} ${lengthText}`
              : `${getProviderDisplayName(effectiveProvider)} · ${t('providerQuota.windowLabel', { key: window.key })}`;
            const ariaLabel = `${windowLabel}: ${percent} — ${t('providerQuota.resetsIn', {
              horizon: horizonText,
            })}`;
            const tooltip = (
              <div className="space-y-0.5">
                <div className="font-medium">{windowLabel}</div>
                <div className="opacity-75">{t('providerQuota.used', { percent })}</div>
                <div className="opacity-75">
                  {t('providerQuota.resetsIn', { horizon: isolateBidi(horizonText) })}
                </div>
                {providerQuota.plan && (
                  <div className="opacity-60">
                    {t('providerQuota.plan', { plan: isolateBidi(providerQuota.plan) })}
                  </div>
                )}
              </div>
            );

            return (
              <Tooltip key={window.key} content={tooltip} position="bottom" tapToToggle multiline>
                <span className="flex items-baseline gap-0.5 text-xs" aria-label={ariaLabel}>
                  <span className="font-semibold text-primary" aria-hidden="true">
                    {badgeText}
                  </span>
                  <span
                    className={`tabular-nums ${usageTextColorClass(clampUtilization(window.usedPercent))}`}
                  >
                    {percent}
                  </span>
                </span>
              </Tooltip>
            );
          })}
          {hasExtraCredits && extraCredits && (
            <Tooltip
              content={
                <div className="space-y-0.5">
                  <div className="font-medium">{t('agentUsage.codexExtraCredits')}</div>
                  <div className="opacity-75">{extraCreditsLabel}</div>
                </div>
              }
              position="bottom"
              tapToToggle
              multiline
            >
              <span
                className="flex items-baseline gap-0.5 text-xs"
                aria-label={`${t('agentUsage.codexExtraCredits')}: ${extraCreditsLabel}`}
              >
                <span className="font-semibold text-primary" aria-hidden="true">+</span>
                <span className="tabular-nums text-muted-foreground">
                  {extraCredits.unlimited ? '∞' : formatCreditBalance(extraCredits.balance, i18n.language)}
                </span>
              </span>
            </Tooltip>
          )}
        </div>
      );
    }

    // ── حصار الحصة يسبق دورة التجديد ────────────────────────────────────────
    // ترتيبٌ مقصود لا مصادفة: الاثنان يتنافسان على نفس البقعة، والدورة تجيب
    // «متى يتجدّد الاشتراك؟» بينما الحصار يجيب «لماذا لا يعمل المزوّد الآن؟».
    // الثاني هو ما يمنع المستخدم من العمل في هذه اللحظة، فعرض موعد تجديدٍ بعد
    // ثلاثة أسابيع مكانه يُخفي السبب الوحيد المهمّ.
    if (quotaBlock) {
      const parts = quotaCountdownParts(quotaBlock.msRemaining);
      const compactKey = {
        days: 'providerQuotaBlock.compactDays',
        hours: 'providerQuotaBlock.compactHours',
        minutes: 'providerQuotaBlock.compactMinutes',
      }[parts.unit];
      const resetsInKey = {
        days: 'providerQuotaBlock.resetsInDays',
        hours: 'providerQuotaBlock.resetsInHours',
        minutes: 'providerQuotaBlock.resetsInMinutes',
      }[parts.unit];

      const compactText = t(compactKey, { value: parts.value });
      const resetsInText = t(resetsInKey, { value: parts.value });
      const resetsOnText = new Date(quotaBlock.resetsAtMs).toLocaleString(i18n.language, {
        day: 'numeric',
        month: 'short',
        hour: '2-digit',
        minute: '2-digit',
      });

      const blockTooltip = (
        <div className="space-y-0.5">
          <div className="font-medium">{t('providerQuotaBlock.title')}</div>
          <div className="opacity-75">{resetsInText}</div>
          <div className="opacity-75">
            {t('providerQuotaBlock.resetsOn', { datetime: isolateBidi(resetsOnText) })}
          </div>
          {/* نصّ المزوّد حرفياً: هو الدليل، وإعادة صياغته تضع تفسيرنا مكانه.
              معزول bidi لأنه إنجليزي داخل تلميح عربي. */}
          {quotaBlock.reason && (
            <div className="opacity-60">
              {t('providerQuotaBlock.providerSaid', { reason: isolateBidi(quotaBlock.reason) })}
            </div>
          )}
        </div>
      );

      return (
        <div
          className="flex flex-shrink-0 select-none items-center"
          aria-label={t('providerQuotaBlock.title')}
        >
          <Tooltip content={blockTooltip} position="bottom" tapToToggle multiline>
            <span
              className="flex items-baseline gap-0.5 text-xs"
              aria-label={`${t('providerQuotaBlock.title')}: ${resetsInText}`}
            >
              <span className="font-semibold text-destructive" aria-hidden="true">
                ⛔
              </span>
              <span className="tabular-nums text-destructive">{isolateBidi(compactText)}</span>
            </span>
          </Tooltip>
        </div>
      );
    }

    // ── حالة الخطأ: قراءة الحصّة تعذّرت ─────────────────────────────────────
    // الدورة (إن أُحضرت) تبقى معلومة ثانوية في التلميح، لا شارة أساسية.
    // مميَّزة عن `none` و`anthropic` وسطح `cycle` الخالص — تلك تسقط إلى الشارة.
    if (quota.surface === 'provider-windows' && providerQuota.status === 'error') {
      const cycleSecondaryText = cycle
        ? `${t('providerCycle.title')}: ${t('providerCycle.renewsIn', { days: cycle.daysRemaining })}`
        : null;
      return (
        <QuotaErrorBadge
          errorLabel={t('providerQuota.readErrorLabel')}
          errorTooltipText={t('providerQuota.readErrorTooltip', {
            provider: isolateBidi(getProviderDisplayName(effectiveProvider)),
          })}
          cycleSecondaryText={cycleSecondaryText}
        />
      );
    }

    // ── حارس الوميض أثناء إعادة المحاولة (B-1290 follow-up) ─────────────────
    // عند انتهاء TTL (180ث) بعد خطأ، يتحوّل `providerQuota.status` إلى
    // `loading`، فيُعطَّل `cycleFallbackResolved`، لكنّ `useProviderCycles` يحتفظ
    // بصفوفه الناجحة — فيبقى `cycle` غير null ويظهر «↻ Nي» لحظات الطلب.
    // `shouldSuppressOnProviderWindowsLoading` (helper نقية مشتركة مع السايدبار)
    // تقطع هذا المسار وتُعيد null حتى يصل حكم نهائي جديد.
    if (shouldSuppressOnProviderWindowsLoading(quota.surface, providerQuota.status)) return null;

    if (!cycle) return null;

    const renewsOn = new Date(cycle.renewsAt).toLocaleDateString(i18n.language, {
      day: 'numeric',
      month: 'short',
    });
    const compact = t('providerCycle.compact', { days: cycle.daysRemaining });
    const renewsInText = t('providerCycle.renewsIn', { days: cycle.daysRemaining });
    // عزل bidi للتاريخ واسم الخطة: نصّ لاتيني/رقمي داخل جملة عربية يقلب ترتيب
    // ما حوله بلا العزل (سابقة SubscriptionCard).
    const cycleTooltip = (
      <div className="space-y-0.5">
        <div className="font-medium">{t('providerCycle.title')}</div>
        <div className="opacity-75">{renewsInText}</div>
        <div className="opacity-75">
          {t('providerCycle.renewsOn', { date: isolateBidi(renewsOn) })}
        </div>
        {cycle.plan && (
          <div className="opacity-75">{t('providerCycle.plan', { plan: isolateBidi(cycle.plan) })}</div>
        )}
        <div className="opacity-60">
          {cycle.anchorSource === 'detected'
            ? t('providerCycle.anchorDetected')
            : t('providerCycle.anchorManual')}
        </div>
      </div>
    );

    // T-1207: مِقبض ثابت للتحقّق البصري. الاختيار باللصيقة المرئية يفشل لأنها
    // مترجَمة — والعطب المقصود بالفحص عطبُ bidi عربي تحديداً — والاختيار بالبنية
    // يكسره أول إعادة تنسيق. ثلاث محاولات لالتقاط هذه الشارة أخفقت لغيابه (T-1099).
    return (
      <div
        className="flex flex-shrink-0 select-none items-center"
        aria-label={t('providerCycle.title')}
        data-testid="provider-cycle-badge"
      >
        <Tooltip content={cycleTooltip} position="bottom" tapToToggle multiline>
          <span className="flex items-baseline gap-0.5 text-xs" aria-label={`${t('providerCycle.title')}: ${renewsInText}`}>
            <span className="font-semibold text-primary" aria-hidden="true">
              ↻
            </span>
            <span className="tabular-nums text-muted-foreground">{isolateBidi(compact)}</span>
          </span>
        </Tooltip>
      </div>
    );
  }

  // Silent during loading / error — keep the header clean.
  if (usageState.status !== 'success') return null;

  const { data } = usageState;
  const extraUsage = hasDisplayableExtraUsageCredits(data.extraUsage)
    ? data.extraUsage
    : null;

  // Build the list of windows that actually have data.
  const items = WINDOWS.flatMap(({ letter, key }) => {
    const win = data[key];
    if (win === null) return [];
    const clamped = clampUtilization(win.utilization);
    return [{ letter, clamped, resetsAt: win.resetsAt }];
  });

  // Nothing to show — all windows are null.
  if (items.length === 0 && !extraUsage) return null;

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
      {extraUsage && (
        <Tooltip
          content={
            <div className="space-y-0.5">
              <div className="font-medium">{t('claudeUsage.windows.extraUsage')}</div>
              <div className="opacity-75">
                {t('claudeUsage.extraUsageDetail', {
                  used: formatCredits(extraUsage.usedCredits, extraUsage.currency, i18n.language),
                  limit: formatCredits(extraUsage.monthlyLimit, extraUsage.currency, i18n.language),
                })}
              </div>
            </div>
          }
          position="bottom"
          tapToToggle
          multiline
        >
          <span
            className="flex items-baseline gap-0.5 text-xs"
            aria-label={`${t('claudeUsage.windows.extraUsage')}: ${formatRemainingHarnessCredits(extraUsage, i18n.language)}`}
          >
            <span className="font-semibold text-primary" aria-hidden="true">+</span>
            <span className="tabular-nums text-muted-foreground">
              {formatRemainingHarnessCredits(extraUsage, i18n.language)}
            </span>
          </span>
        </Tooltip>
      )}
    </div>
  );
}
