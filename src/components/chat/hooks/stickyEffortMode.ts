/**
 * قرار استعادة مستوى التفكير المثبَّت لكل محادثة — دالّة صرفة.
 *
 * المستوى (effort/thinking mode) خاصية المحادثة لا خاصية الرسالة: يُختار مرّة
 * ويبقى حتى يغيّره المستخدم. المنطق مُخرَج هنا صِرفاً لأن حالاته الحديّة —
 * وتحديداً ولادة مُعرِّف الجلسة بعد أول إرسال — هي بالضبط ما ينكسر بصمت داخل
 * `useEffect` بلا اختبار.
 *
 * الحالات الأربع:
 *  1. لا مُعرِّف جلسة بعد (محادثة جديدة لم تُرسَل): لا شيء يُستعاد ⇒ keep.
 *  2. أول تشغيل ومعنا مُعرِّف (فتح محادثة قائمة أو إعادة تحميل الصفحة):
 *     يُستعاد المخزَّن، وإلا الافتراضي ⇒ apply.
 *  3. null ← id على مُؤلِّف مُركَّب أصلاً (وُلد المُعرِّف بعد أول إرسال): ليست
 *     «تبديل محادثة»؛ اختيار المستخدم قبل الإرسال يخصّ هذه المحادثة ⇒ keep.
 *  4. id ← id مختلف (تبديل محادثة فعلي): يُستعاد مخزَّن الجديدة، وإلا الافتراضي.
 */
export type StickyEffortDecision = { action: 'keep' } | { action: 'apply'; mode: string };

export type StickyEffortInput = {
  /** مُعرِّف الجلسة المعروضة الآن (null قبل أول إرسال في محادثة جديدة). */
  sessionId: string | null;
  /** مُعرِّف الجلسة في التشغيل السابق للأثر. */
  previousSessionId: string | null;
  /** هل هذا أول تشغيل للأثر منذ تركيب المُؤلِّف؟ */
  isFirstRun: boolean;
  /** القيمة المخزَّنة لهذه الجلسة (null حين لا شيء مخزَّن). */
  storedMode: string | null;
  /** هويّات الأوضاع المعروفة — ما عداها قيمة فاسدة تُهمَل. */
  knownModeIds: readonly string[];
  /** الافتراضي حين لا مخزَّن صالح. */
  defaultMode: string;
};

export function resolveStickyEffortMode(input: StickyEffortInput): StickyEffortDecision {
  const { sessionId, previousSessionId, isFirstRun, storedMode, knownModeIds, defaultMode } = input;

  if (!sessionId) {
    return { action: 'keep' };
  }

  if (!isFirstRun && (previousSessionId === null || previousSessionId === sessionId)) {
    return { action: 'keep' };
  }

  if (storedMode !== null && knownModeIds.includes(storedMode)) {
    return { action: 'apply', mode: storedMode };
  }

  return { action: 'apply', mode: defaultMode };
}
