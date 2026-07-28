/**
 * هندسة نافذة مثبَّتة على زرّها — دالّة صرفة.
 *
 * النافذة المتمركزة وسط الشاشة تقطع الصلة بين ما ضغطتَه وما ظهر: العين تعود
 * إلى الزرّ لتتأكّد أيّ عنصر فتحها. التثبيت تحت الزرّ يُبقي الصلة قائمة.
 *
 * مُخرَجة صِرفةً لأن حالاتها الحديّة هندسية لا بصرية، فتُختبَر بأرقام بدل
 * فحصها بالعين: زرّ قرب حافّة، ونافذة أطول من المساحة تحته، وRTL حيث يجب
 * التثبيت بـ`right` لا `left` وإلا تمدّدت النافذة خارج الحافّة.
 *
 * design-ok: الإحداثيات هنا **فيزيائية عمداً** ولا بديل منطقي لها. المُخرَج
 * أنماط `position: fixed` لعنصر في portal تُحسب بالنسبة إلى نافذة المتصفح لا
 * إلى تدفّق نصّ، والاتجاه مُعالَج صراحةً بـ`isRtl` الذي يختار الحافّة المثبَّتة.
 * واستعمال inset-inline هنا يقع في فخّ موثَّق في هذا المستودع: إضافة
 * tailwindcss-rtl تضبط left وright معاً داخل جزر dir، فيتمدّد العنصر ويقع في
 * الجهة الخطأ. ونفس النهج مطبَّق أصلاً في ThinkingModeSelector.tsx.
 */

export type Rect = { top: number; bottom: number; left: number; right: number; width: number };

export type Viewport = { width: number; height: number };

export type AnchoredPlacement = {
  /** يُضبط حين تُفتح أسفل الزرّ. */
  top?: number;
  /**
   * يُضبط حين تنقلب فوق الزرّ. التثبيت من الأسفل لا الأعلى مقصود: نافذة
   * مثبَّتة بـ`top` محسوب من ارتفاع مقيس ثم نمت (سطر إضافي، خطّ ملتفّ)
   * تتمدّد **نزولاً فتغطّي الزرّ نفسه**. التثبيت بالأسفل يجعلها تنمو صعوداً.
   */
  bottom?: number;
  /** أحدهما فقط يُضبط: RTL يثبَّت بـ`right` كي يتمدّد يساراً بطبيعته. */
  left?: number;
  right?: number;
  width: number;
  maxHeight: number;
  /** للتشخيص وللاختبار: أين استقرّت فعلاً. */
  placement: 'below' | 'above';
};

export type AnchorInput = {
  trigger: Rect;
  viewport: Viewport;
  /** الارتفاع المقيس للنافذة (0 قبل أول قياس). */
  measuredHeight: number;
  /** أقصى عرض مرغوب؛ يُقلَّص عند ضيق الشاشة. */
  preferredWidth: number;
  isRtl: boolean;
};

const SPACING = 8;

export function resolveAnchoredPlacement(input: AnchorInput): AnchoredPlacement {
  const { trigger, viewport, measuredHeight, preferredWidth, isRtl } = input;

  const padding = viewport.width < 640 ? 12 : 16;
  const width = Math.min(preferredWidth, Math.max(160, viewport.width - padding * 2));

  const spaceBelow = viewport.height - trigger.bottom - SPACING - padding;
  const spaceAbove = trigger.top - SPACING - padding;
  // تُفتح أسفل الزرّ ما لم يكن أعلاه أوسع فعلاً — لا لمجرّد ضيق الأسفل، وإلا
  // قفزت النافذة بين الجهتين مع كل تغيّر طفيف في الارتفاع.
  const desired = Math.min(measuredHeight || 320, 320);
  const openBelow = spaceBelow >= desired || spaceBelow >= spaceAbove;

  // الارتفاع المتاح هو مساحة الجهة المختارة وحدها، لا ارتفاع الشاشة: لو
  // سُمح للنافذة بالنمو إلى ارتفاع الشاشة لتجاوزت الجهة التي فُتحت فيها.
  const availableHeight = Math.max(140, Math.min(viewport.height - padding * 2, openBelow ? spaceBelow : spaceAbove));

  const base: Omit<AnchoredPlacement, 'left' | 'right'> = {
    width,
    maxHeight: availableHeight,
    placement: openBelow ? 'below' : 'above',
    ...(openBelow
      ? { top: Math.max(padding, trigger.bottom + SPACING) }
      : { bottom: Math.max(padding, viewport.height - (trigger.top - SPACING)) }),
  };

  if (isRtl) {
    const rightEdge = viewport.width - trigger.right;
    return {
      ...base,
      right: Math.max(padding, Math.min(rightEdge, viewport.width - width - padding)),
    };
  }

  const leftEdge = trigger.left;
  return {
    ...base,
    left: Math.max(padding, Math.min(leftEdge, viewport.width - width - padding)),
  };
}
