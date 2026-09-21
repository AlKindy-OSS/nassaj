/**
 * سياسة «الصفحة أمام المستخدم فعلاً» — **آلية واحدة** يشترك فيها كل من يقيس
 * انتباه المستخدم، لا نسخة لكل مستهلك.
 *
 * وُلدت من `pageTitleNotification` (علامة `[Done]`): مؤقّتٌ يبدأ لحظة الحدث
 * ينقضي والمستخدم في تبويب آخر، فيزول ما لم يره أحد. علامة العنوان حلّت ذلك
 * بانتظار عودته؛ ثم احتاج شريطُ الخطأ في المحادثة السياسةَ نفسها حرفياً
 * (‏T-1294) — فاستُخرجت هنا بدل كتابة ثانيةٍ تتباعد عن الأولى مع الوقت.
 *
 * «نشطة» = مرئية **وذات تركيز** معاً: نافذةٌ مرئية خلف نافذة أخرى ليست أمام
 * المستخدم فعلاً.
 */

export const pageIsActive = (): boolean => (
  typeof document !== 'undefined'
  && document.visibilityState === 'visible'
  && document.hasFocus()
);

/** إلغاء انتظارٍ لم يقع بعد. استدعاؤه بعد وقوعه لا يفعل شيئاً (آمن دائماً). */
export type CancelPageActivation = () => void;

/**
 * تشغيل عمل **حين تصير الصفحة أمام المستخدم**، أو فوراً إن كانت كذلك الآن.
 *
 * يُنفَّذ مرّة واحدة ثم يفكّ مستمعيه. الثلاثة مقصودة: `visibilitychange` لتبديل
 * التبويب، و`focus` لتبديل النافذة، و`click` احتياطٌ لنقرةٍ داخل الصفحة لا
 * يسبقها أيٌّ منهما.
 */
export function runWhenPageActive(run: () => void): CancelPageActivation {
  if (typeof document === 'undefined' || typeof window === 'undefined') {
    // بيئة بلا DOM: لا معنى لانتظارٍ لا يمكن أن ينتهي.
    run();
    return () => {};
  }

  if (pageIsActive()) {
    run();
    return () => {};
  }

  const detach = (): void => {
    document.removeEventListener('visibilitychange', onReturn);
    window.removeEventListener('focus', onReturn, true);
    window.removeEventListener('click', onReturn, true);
  };

  function onReturn(): void {
    if (!pageIsActive()) {
      return;
    }
    detach();
    run();
  }

  document.addEventListener('visibilitychange', onReturn);
  window.addEventListener('focus', onReturn, true);
  window.addEventListener('click', onReturn, true);

  return detach;
}
