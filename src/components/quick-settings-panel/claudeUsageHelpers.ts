// Pure helpers for rendering Claude usage. No React, no i18n side effects.

import type { ClaudeExtraUsage } from './claudeUsageTypes';

// Bar color thresholds (matches TokenUsageSummary context-rot scale):
// emerald < 50 (safe), amber < 75 (attention), orange < 90 (warning), red >= 90 (critical).
// Returns Tailwind background classes so dark mode is handled by the palette.
export function usageBarColorClass(utilization: number): string {
  if (utilization < 50) return 'bg-emerald-500';
  if (utilization < 75) return 'bg-amber-500';
  if (utilization < 90) return 'bg-orange-500';
  return 'bg-red-500';
}

// Same thresholds as usageBarColorClass but returns text color classes
// for use in compact inline indicators (e.g. the header usage row).
export function usageTextColorClass(utilization: number): string {
  if (utilization < 50) return 'text-emerald-500';
  if (utilization < 75) return 'text-amber-500';
  if (utilization < 90) return 'text-orange-500';
  return 'text-red-500';
}

// Clamp utilization into the 0-100 range the bar expects.
export function clampUtilization(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, value));
}

/**
 * Human-readable "resets in" string from an ISO timestamp.
 *
 * - Within 24h: relative ("in 26 minutes" / "بعد ٢٦ دقيقة") via Intl.RelativeTimeFormat.
 * - Beyond 24h: absolute weekday + time ("Thu 7:00 AM") via Intl.DateTimeFormat.
 *
 * `locale` drives both wording and digit shaping (Arabic-Indic digits for `ar`).
 * Returns null when the timestamp is missing or already in the past.
 */
export function formatResetTime(
  resetsAt: string | null,
  locale: string,
  now: number = Date.now(),
): string | null {
  if (!resetsAt) return null;

  const target = new Date(resetsAt).getTime();
  if (Number.isNaN(target)) return null;

  const diffMs = target - now;
  if (diffMs <= 0) return null;

  const ONE_DAY_MS = 24 * 60 * 60 * 1000;

  if (diffMs < ONE_DAY_MS) {
    const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
    const diffMinutes = Math.round(diffMs / 60_000);
    if (diffMinutes < 60) {
      return rtf.format(Math.max(1, diffMinutes), 'minute');
    }
    const diffHours = Math.round(diffMs / 3_600_000);
    return rtf.format(diffHours, 'hour');
  }

  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: 'numeric',
    minute: '2-digit',
  }).format(new Date(target));
}

// Locale-aware percentage label, e.g. "30%" / "٣٠٪".
export function formatPercent(utilization: number, locale: string): string {
  const value = clampUtilization(utilization);
  return new Intl.NumberFormat(locale, {
    style: 'percent',
    maximumFractionDigits: value % 1 === 0 ? 0 : 1,
  }).format(value / 100);
}

// Locale-aware currency credits, e.g. "$51.27 / $80.00".
//
// `amountInCents` is in CENTS (minor currency units): the oauth/usage endpoint
// reports extra_usage.used_credits / monthly_limit in cents (e.g. 5127 = $51.27),
// and the server forwards them unchanged. Convert here, at the formatting edge.
/**
 * Whether the provider supplied a complete extra-credit amount that can be
 * stated truthfully.  A missing or malformed amount must stay absent: showing
 * zero would claim that the customer has exhausted a credit pool.
 */
export function hasDisplayableExtraUsageCredits(
  extraUsage: {
    enabled: boolean;
    usedCredits: number | null;
    monthlyLimit: number | null;
    utilization: number | null;
    currency: string | null;
  } | null | undefined,
): extraUsage is NonNullable<typeof extraUsage> & {
  usedCredits: number;
  monthlyLimit: number;
  utilization: number;
  currency: string;
} {
  if (!extraUsage?.enabled) return false;
  const { usedCredits, monthlyLimit, utilization, currency } = extraUsage;
  return Boolean(
    typeof usedCredits === 'number'
      && Number.isFinite(usedCredits)
      && usedCredits >= 0
      && typeof monthlyLimit === 'number'
      && Number.isFinite(monthlyLimit)
      && monthlyLimit >= 0
      && usedCredits <= monthlyLimit
      && typeof utilization === 'number'
      && Number.isFinite(utilization)
      && utilization >= 0
      && utilization <= 100
      && typeof currency === 'string'
      && currency.trim(),
  );
}

export function formatCredits(
  amountInCents: number,
  currency: string,
  locale: string,
): string {
  const amount = amountInCents / 100;
  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency,
      maximumFractionDigits: 2,
    }).format(amount);
  } catch {
    // Unknown currency code — fall back to a plain number with the code.
    return `${new Intl.NumberFormat(locale).format(amount)} ${currency}`;
  }
}

/**
 * Plain (non-currency) balance formatting for provider-native credit units
 * (e.g. Codex extra credits) — at most 2 fraction digits, locale-shaped
 * digits. Distinct from `formatCredits`, which is for cents-denominated,
 * currency-coded amounts (Claude harness extra usage). Both
 * HeaderUsageIndicator and ClaudeUsageCollapsed render the same "+N" badge
 * for provider credits; sharing this keeps their formatting from drifting.
 */
export function formatCreditBalance(balance: number, locale: string): string {
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 2 }).format(balance);
}

/**
 * قرار عرض واحد لرصيد هارنس Claude الإضافي (‏"+" badge في الهيدر/الشريط
 * الجانبي)، بديل تكرار الحساب في كل سطح. مقصودٌ أنها **لا** تستدعي
 * `hasDisplayableExtraUsageCredits`: تلك تخدم شريط التقدّم الكامل
 * (‏ClaudeUsageSection/AgentUsageSection) وتشترط `usedCredits ≤ monthlyLimit`
 * ونسبة استهلاك وعملة صالحتين لرسم الشريط ولون تنبيهه — وهو نطاقٌ خارج هذا
 * الإصلاح (القرار بشأن ألوانه عند المالك). أمّا شارة "+" فمعناها أبسط: رقمٌ أو
 * "صفر مؤكَّد" أو اختفاء، ولا تحتاج نسبة استهلاك إطلاقاً ولا حتى عملة لتقرير
 * الصفر — فتجاوز الحدّ (‏`usedCredits > monthlyLimit`، وهي حالة اعتذار توفّرها
 * الخادم فعلاً) هو نفاد مؤكَّد بقدر المساواة تماماً.
 *
 * `currency` في حالة `zero` قد يكون `null`: الحدّ/المستهلك قد يصلان دون عملة
 * على حساب مُفعَّل (تجاوز الحدّ)، وحينها يُعرض "0" مجرَّدة لا مبلغاً مُختلَقاً.
 */
export type ClaudeExtraUsageDisplay =
  | { kind: 'hidden' }
  | { kind: 'zero'; usedCents: number; limitCents: number; currency: string | null }
  | { kind: 'amount'; remainingCents: number; usedCents: number; limitCents: number; currency: string };

export function resolveClaudeExtraUsageDisplay(
  extraUsage: ClaudeExtraUsage | null | undefined,
): ClaudeExtraUsageDisplay {
  if (!extraUsage || !extraUsage.enabled) return { kind: 'hidden' };

  const { usedCredits, monthlyLimit, currency } = extraUsage;
  // الحدّ مفقود: معناه غير مؤكَّد، فلا صفر ولا مبلغ يُختلَق منه.
  if (typeof monthlyLimit !== 'number' || !Number.isFinite(monthlyLimit) || monthlyLimit < 0) {
    return { kind: 'hidden' };
  }
  if (typeof usedCredits !== 'number' || !Number.isFinite(usedCredits) || usedCredits < 0) {
    return { kind: 'hidden' };
  }

  const validCurrency =
    typeof currency === 'string' && currency.trim() ? currency : null;

  // نافدٌ فعلاً — بما فيه تجاوز الحدّ، لا المساواة معه فقط — بلا حاجة لعملة
  // معروفة لتقرير هذا وحده.
  if (usedCredits >= monthlyLimit) {
    return { kind: 'zero', usedCents: usedCredits, limitCents: monthlyLimit, currency: validCurrency };
  }

  // الباقي الموجب يحتاج عملة ليُصاغ مبلغاً صادقاً؛ غيابها يُخفي لا يخترع رقماً.
  if (!validCurrency) return { kind: 'hidden' };
  return {
    kind: 'amount',
    remainingCents: monthlyLimit - usedCredits,
    usedCents: usedCredits,
    limitCents: monthlyLimit,
    currency: validCurrency,
  };
}

/**
 * نصّ شارة "+" الظاهر (والمُستخدَم أيضاً في aria-label) — حساب واحد بدل تكراره
 * في الهيدر والشريط الجانبي. "∞" لا تصدر من هنا (ملك حصص Codex/GLM فحسب عبر
 * `resolveCreditDisplay`)؛ هذه لحصّة كلود التي لا تعرف "غير محدود".
 */
export function formatClaudeExtraBadgeText(
  display: ClaudeExtraUsageDisplay,
  locale: string,
): string | null {
  if (display.kind === 'hidden') return null;
  if (display.kind === 'amount') return formatCredits(display.remainingCents, display.currency, locale);
  return display.currency ? formatCredits(0, display.currency, locale) : formatCreditBalance(0, locale);
}

/**
 * مبلغا التلميح (المستهلَك/الحدّ) بصياغة العملة — `null` حين لا عملة معروفة
 * (‏نفاد بتجاوز الحدّ بلا عملة)، إذ لا مبلغ صادق يُقال بلا وحدة.
 */
export function formatClaudeExtraDetailAmounts(
  display: ClaudeExtraUsageDisplay,
  locale: string,
): { used: string; limit: string } | null {
  if (display.kind === 'hidden' || !display.currency) return null;
  return {
    used: formatCredits(display.usedCents, display.currency, locale),
    limit: formatCredits(display.limitCents, display.currency, locale),
  };
}
