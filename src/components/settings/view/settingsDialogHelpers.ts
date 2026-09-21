/**
 * مساعدات منطق مودال الإعدادات — معزولة عن DOM لتسهيل الاختبار.
 *
 * وُجدت هذه الوحدة لأن حدثَي Escape والتركيز في Settings.tsx كانا
 * يختلطان بالـDOM مباشرةً، فكان أيُّ اختبار يحتاج محاكاةً متشعّبة.
 * الآن القرار المنطقي مستقلّ والـDOM استدعاء واحد في كلّ مكان.
 */

/** ما الذي يجب أن يُغلق عند ضغط Escape؟ */
export type EscapeTarget =
  /** مودال متداخل داخل dialogRef مفتوح — اتركه يعالج Escape وحده. */
  | 'none'
  /** ProviderLoginModal مفتوح — أغلقه هو (لا الإعدادات). */
  | 'login-modal'
  /** لا شيء متداخل — أغلق الإعدادات. */
  | 'settings';

/**
 * يُحدّد ما الذي يجب أن يُغلق عند ضغط Escape.
 *
 * الترتيب: المودال الأعمق أولاً.
 *   1. مودال متداخل داخل dialog الإعدادات (ResetPassword، UserDialog، إلخ)
 *      → تجاهل هنا، دع المودال المتداخل يستلمه من نقطة استماعه.
 *   2. ProviderLoginModal مفتوح (شقيق خارج dialogRef، بلا معالج Escape خاصّ)
 *      → Settings يُغلقه نيابةً عنه.
 *   3. لا شيء متداخل → أغلق الإعدادات.
 */
export function resolveEscapeTarget(options: {
  /** هل يوجد عنصر [role=dialog] داخل لوح الإعدادات الآن؟ */
  hasNestedDialog: boolean;
  /** هل ProviderLoginModal مفتوح؟ */
  showLoginModal: boolean;
}): EscapeTarget {
  if (options.hasNestedDialog) return 'none';
  if (options.showLoginModal) return 'login-modal';
  return 'settings';
}

/**
 * يفحص إذا كان اللوح يحوي مودالاً متداخلاً مفتوحاً.
 * آمن مع null (يُعيد false إذا لم يُمرَّر element).
 */
export function hasActiveNestedDialog(dialogEl: Element | null): boolean {
  if (!dialogEl) return false;
  return dialogEl.querySelector('[role="dialog"]') !== null;
}
