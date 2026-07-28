/**
 * T-849 — كاشف أمر «/btw» (سؤال جانبي «بالمناسبة»).
 *
 * `/btw <السؤال>` سؤالٌ جانبي على سياق الجلسة الجارية يُجاب عليه خادمياً كجلسة
 * SDK مفروكة (fork) وتُعرض إجابته في overlay — لا يدخل سجل المحادثة ولا يُطلق
 * دوراً. هذه دوالّ خالصة (بلا حالة ولا I/O) يتشاركها موضعان فقط: بوابة تمكين
 * الإرسال في ChatComposer، واعتراض التوجيه في handleSubmit (useChatComposerState).
 * أما منطق القناة نفسه (WS/overlay/الحالة) ففي useBtwSideChannel + BtwOverlay.
 *
 * البادئة تتطلّب مسافة لاحقة: «/btw <سؤال>». «/btwx» أو «/btw» وحدها ليست أمراً.
 * التطابق غير حسّاس لحالة الأحرف في كلمة الأمر (يقبل «/BTW ») تسامحاً.
 */

/** بادئة الأمر — تتطلّب مسافة بعد «/btw» وسؤالاً غير فارغ بعدها. */
export const BTW_PREFIX = '/btw ';

/**
 * نصّ السؤال بعد «/btw » بعد إزالة الفراغات المحيطة. سلسلة فارغة إن لم يكن
 * الإدخال أمر btw صالحاً (بادئة غير مطابقة أو سؤال فارغ).
 */
export function parseBtwQuestion(input: string): string {
  if (typeof input !== 'string') {
    return '';
  }
  // نتجاهل الفراغ البادئ فقط كي يعمل الأمر حتى لو سبقته مسافات في المُؤلِّف.
  const leadingTrimmed = input.replace(/^\s+/, '');
  if (leadingTrimmed.slice(0, BTW_PREFIX.length).toLowerCase() !== BTW_PREFIX) {
    return '';
  }
  return leadingTrimmed.slice(BTW_PREFIX.length).trim();
}

/** صحيحٌ فقط لأمر «/btw <سؤال غير فارغ>» جيّد التكوين. */
export function isBtwCommand(input: string): boolean {
  return parseBtwQuestion(input).length > 0;
}
