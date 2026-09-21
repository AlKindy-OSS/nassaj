/**
 * عتبة تنبيه خمول الجلسة لكل هارنس (T-1765).
 *
 * العتبة = مدة كاش المطالبات كما يعلنها المزوّد. null = لا معلومة فلا تنبيه
 * (قرار المالك 2026-09-12: قراءة مباشرة من المزوّد، ولا افتراض عند غيابها).
 */

const MINUTE_MS = 60 * 1_000;

export const CODEX_GPT_5_6_IDLE_MS = 30 * MINUTE_MS;

export type IdleThresholdInput = {
  /** مزوّد الجلسة المعروضة (displayProvider). */
  provider: string;
  /** النموذج الفعّال للجلسة. */
  model: string | null | undefined;
  /** المحرّك المُحلّ (resolveEffectiveEngine)؛ null = المحرّك الأصيل للمزوّد. */
  engine: string | null;
  /**
   * مدة كاش Claude بالدقائق كما قرأها الخادم من `usage.cache_creation` لآخر
   * طلب كتب في الكاش (60 أو 5)؛ null = لا قراءة.
   */
  claudeCacheTtlMinutes: number | null | undefined;
};

/** true لنماذج GPT من 5.6 فما بعد (gpt-5.6، gpt-5.6-sol، gpt-6…). */
export function isGpt56OrLater(model: string | null | undefined): boolean {
  const match = /^gpt-(\d+)(?:\.(\d+))?/i.exec((model ?? '').trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2] ?? 0);
  return major > 5 || (major === 5 && minor >= 6);
}

/** يعيد عتبة الخمول بالمللي ثانية، أو null حين لا تتوفر مدة كاش معلنة. */
export function resolveIdleThresholdMs({
  provider,
  model,
  engine,
  claudeCacheTtlMinutes,
}: IdleThresholdInput): number | null {
  if (provider === 'claude') {
    // جلسة Claude على محرّك غير Anthropic لا تخضع لكاش Anthropic.
    if (engine !== null) return null;
    return claudeCacheTtlMinutes === 60 || claudeCacheTtlMinutes === 5
      ? claudeCacheTtlMinutes * MINUTE_MS
      : null;
  }
  if (provider === 'codex') {
    return isGpt56OrLater(model) ? CODEX_GPT_5_6_IDLE_MS : null;
  }
  return null;
}
