// Pure helpers for rendering Claude usage. No React, no i18n side effects.

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
    usedCredits: number;
    monthlyLimit: number;
    utilization: number;
    currency: string;
  } | null | undefined,
): extraUsage is NonNullable<typeof extraUsage> {
  return Boolean(
    extraUsage?.enabled
      && Number.isFinite(extraUsage.usedCredits)
      && extraUsage.usedCredits >= 0
      && Number.isFinite(extraUsage.monthlyLimit)
      && extraUsage.monthlyLimit >= 0
      && extraUsage.usedCredits <= extraUsage.monthlyLimit
      && Number.isFinite(extraUsage.utilization)
      && extraUsage.utilization >= 0
      && extraUsage.utilization <= 100
      && typeof extraUsage.currency === 'string'
      && extraUsage.currency.trim(),
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
 * Remaining harness credits (monthlyLimit - usedCredits), formatted as
 * currency via `formatCredits`. Both HeaderUsageIndicator and
 * ClaudeUsageCollapsed compute this identically for the Claude "extra usage"
 * badge (visible text + aria-label duplicate the same subtraction) — a
 * single helper keeps them from drifting apart.
 */
export function formatRemainingHarnessCredits(
  extraUsage: { monthlyLimit: number; usedCredits: number; currency: string },
  locale: string,
): string {
  return formatCredits(extraUsage.monthlyLimit - extraUsage.usedCredits, extraUsage.currency, locale);
}
