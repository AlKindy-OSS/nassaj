/**
 * sessionActivity — مصدر الحقيقة العميلي لسؤال «هل هذه الجلسة تعمل الآن؟».
 *
 * الخلفية (B-208): ظهور بطاقة العمليات الجارية (AgentStatusCard) معلَّق كلياً
 * على `isLoading`، و`isLoading` لم يكن له مصدر REST إطلاقاً — مصدره الوحيد
 * إطارات WS. بعد تحديث صفحة المتصفح لا يصل أي إطار `session-status` جديد
 * (الخادم يبثّ إعادة البثّ ثم mirror ثم `session-status`، والبثّ الحيّ يستبدل
 * فتحة `latestMessage` في نفس المللي‑ثانية) فتبقى البطاقة مخفية حتى يضغط
 * المستخدم زر تحديث المحادثة يدوياً.
 *
 * هذا الملف يحلّ الجزء الحتمي من المشكلة بثلاث قطع صغيرة متلازمة:
 *
 *   1. `readIsProcessing` — **ترميز الحقيقة**: غياب `isProcessing` = غير نشطة.
 *      لا «امسح فقط عند false صريح» (كان سيُنتج مؤشّراً عالقاً للأبد على أي
 *      حمولة قديمة/مبتورة لا تحمل الحقل).
 *
 *   2. سجلّ **epoch** لكل جلسة: عدّاد رتيب يُرفع عند كل حدث سُلطوي على حالة
 *      التشغيل (`session-status`، `complete`، `error`، ومسح التعافي بعد إعادة
 *      الاتصال). أي لقطة REST أُطلقت قبل الحدث تُهمَل عند عودتها. بدونه:
 *      إجابة «نشطة» تصل بعد `complete` تُبقي `isLoading=true` إلى الأبد.
 *
 *   3. `runSessionActivityProbe` — لقطة REST واحدة محروسة بالـepoch.
 *
 * السجلّ على مستوى الوحدة (لا React state) عمداً: كاتبوه (معالج إطارات WS،
 * مسح إعادة الاتصال) وقارئه (اللقطة اللاتزامنية) يعيشون في أشجار hooks مختلفة،
 * والقيمة ليست بيانات عرض — لا يجوز أن تُسبّب re-render.
 */

import { authenticatedFetch } from '../../../utils/api';

/* ------------------------------------------------------------------ */
/*  1. ترميز الحقيقة                                                   */
/* ------------------------------------------------------------------ */

/**
 * القراءة الوحيدة المعتمدة لحقل `isProcessing` أياً كان مصدره (إطار WS
 * `session-status` أو ردّ REST ‏`/activity`).
 *
 * **غياب الحقل = غير نشطة.** الترميز مقصود وغير قابل للتفاوض: العميل يعامل
 * `undefined`/`null`/أي قيمة غير `true` معاملة «متوقفة». الخادم يضمن boolean
 * دائماً، لكن العميل لا يبني عليه.
 */
export function readIsProcessing(
  payload: { isProcessing?: unknown } | null | undefined,
): boolean {
  return payload?.isProcessing === true;
}

/* ------------------------------------------------------------------ */
/*  2. سجلّ الـepoch                                                    */
/* ------------------------------------------------------------------ */

const epochs = new Map<string, number>();

/**
 * يرفع epoch الجلسة. يُستدعى عند كل حدث سُلطوي يحسم حالة التشغيل:
 * إطار `session-status`، ‏`complete`، ‏`error`، ومسح التعافي بعد إعادة الاتصال.
 */
export function bumpSessionActivityEpoch(sessionId: string | null | undefined): void {
  if (!sessionId) return;
  epochs.set(sessionId, (epochs.get(sessionId) ?? 0) + 1);
}

/** يقرأ epoch الجلسة الحالي (0 لجلسة لم يُسجَّل لها حدث بعد). */
export function readSessionActivityEpoch(sessionId: string | null | undefined): number {
  if (!sessionId) return 0;
  return epochs.get(sessionId) ?? 0;
}

/** للاختبارات فقط: يمسح السجلّ بين الحالات. */
export function resetSessionActivityEpochs(): void {
  epochs.clear();
}

/* ------------------------------------------------------------------ */
/*  3. لقطة REST المحروسة                                              */
/* ------------------------------------------------------------------ */

/** مسار النقطة الحتمية: `200 {"isProcessing": boolean}` دائماً. */
export const sessionActivityUrl = (sessionId: string): string =>
  `/api/providers/sessions/${encodeURIComponent(sessionId)}/activity`;

/**
 * نتيجة اللقطة:
 *  - `applied` — الردّ قال «نشطة» وما يزال صالحاً ⇒ نُودي `onActive`.
 *  - `idle`    — الردّ قال «غير نشطة» (أو غاب الحقل) ⇒ لا شيء يُرفع.
 *  - `stale`   — تغيّر epoch الجلسة أثناء الطلب ⇒ اللقطة متأخرة، تُهمَل.
 *  - `unknown` — تعذّر الوصول للنقطة (غير منشورة بعد / شبكة / 4xx) ⇒ لا شيء.
 */
export type SessionActivityProbeOutcome = 'applied' | 'idle' | 'stale' | 'unknown';

/** جالب افتراضي: يُعيد الحمولة، أو `null` عند أي فشل (تدهور صامت آمن). */
async function defaultFetchActivity(
  sessionId: string,
): Promise<{ isProcessing?: unknown } | null> {
  try {
    const response = await authenticatedFetch(sessionActivityUrl(sessionId));
    if (!response.ok) return null;
    return (await response.json()) as { isProcessing?: unknown };
  } catch {
    return null;
  }
}

/**
 * لقطة واحدة لحالة الجلسة، محروسة بالـepoch.
 *
 * الحارس (بند 5 من المواصفة): يُلتقط epoch الجلسة **قبل** إطلاق الطلب ويُقارَن
 * بعد عودته. إن عولج للجلسة `complete`/`error`/`session-status` في الأثناء
 * فالردّ متأخر ولا يُطبَّق — وإلا لأبقت إجابةُ «نشطة» الواصلةُ بعد `complete`
 * المؤشّرَ عالقاً إلى الأبد.
 *
 * **رافعة فقط، لا تخفض**: عند «غير نشطة» لا نمسح `isLoading` — المزامنة
 * الأخرى في `useChatSessionState` أحادية الاتجاه أيضاً، وإدخال خافض ثانٍ
 * بلا سلطة يفتح باب مسح مؤشّر إرسالٍ محلّي سبق اللقطة.
 */
export async function runSessionActivityProbe({
  sessionId,
  onActive,
  fetchActivity = defaultFetchActivity,
}: {
  sessionId: string;
  onActive: () => void;
  fetchActivity?: (sessionId: string) => Promise<{ isProcessing?: unknown } | null>;
}): Promise<SessionActivityProbeOutcome> {
  if (!sessionId) return 'unknown';

  const epochAtDispatch = readSessionActivityEpoch(sessionId);
  const payload = await fetchActivity(sessionId);
  if (payload === null) return 'unknown';

  // حارس epoch: أي حدث سُلطوي بعد لحظة الإطلاق يُبطل هذه اللقطة.
  if (readSessionActivityEpoch(sessionId) !== epochAtDispatch) return 'stale';

  if (!readIsProcessing(payload)) return 'idle';

  onActive();
  return 'applied';
}

/* ------------------------------------------------------------------ */
/*  4. سياسة القرار — دوالّ صرفة (قابلة للاختبار بلا React)            */
/* ------------------------------------------------------------------ */

/**
 * هل يُنزَّل `isLoading` بعد مسار التعافي (إعادة اتصال / تحديث يدوي)؟
 *
 * **`'unknown'` ليست إجابة**: النقطة غير منشورة بعد أو الشبكة فشلت. إنزال
 * المؤشّر عليها كان يُخفي البطاقة وزر STOP لبقية التشغيل الحيّ بلا تعافٍ
 * (مراجعة qa-critic، حرج 3) — والخطر مضاعَف لأن `build:client` وحده ينشر
 * العميل، فالانحدار يهبط قبل الخادم.
 *
 * القاطع وحده يُنزِل: `'idle'` = الخادم قال صراحةً «لا تشغيل».
 * ‏`'applied'` = تشغيل حيّ ⇒ لا إنزال. ‏`'stale'` = حسمه حدثٌ أحدث ⇒ لا إنزال.
 */
export function shouldClearLoadingAfterRecovery(
  outcome: SessionActivityProbeOutcome | 'skipped',
): boolean {
  return outcome === 'idle';
}

/**
 * هل يُعرض زرّ التحديث اليدوي (مخرج الطوارئ)؟
 *
 * كان مشروطاً بـ`!isLoading`، فأي موجب خاطئ في `isLoading` يُخفي المخرج
 * الوحيد. لكن إظهاره أثناء تشغيل حيّ **قبل** توفّر مصدر حتمي يعيد رفع المؤشّر
 * يقلب المخرج إلى فخّ. فالبوّابة ذاتية الشفاء: يظهر أثناء التشغيل فقط بعد أن
 * تُجيب `/activity` إجابةً قاطعة مرّة واحدة على الأقل.
 */
export function shouldShowManualRefresh({
  hasSession,
  isLoading,
  activitySourceAvailable,
}: {
  hasSession: boolean;
  isLoading: boolean;
  activitySourceAvailable: boolean;
}): boolean {
  if (!hasSession) return false;
  if (!isLoading) return true;
  return activitySourceAvailable;
}
