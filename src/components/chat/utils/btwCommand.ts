/**
 * T-849 — كاشف أمر «/btw» (سؤال جانبي «بالمناسبة»).
 *
 * `/btw <السؤال>` سؤالٌ جانبي على سياق الجلسة الجارية يُجاب عليه خادمياً كجلسة
 * SDK مفروكة (fork) وتُعرض إجابته في overlay — لا يدخل سجل المحادثة ولا يُطلق
 * دوراً. هذه دوالّ خالصة (بلا حالة ولا I/O) يتشاركها موضعان فقط: بوابة تمكين
 * الإرسال في ChatComposer، واعتراض التوجيه في handleSubmit (useChatComposerState).
 * أما منطق القناة نفسه (WS/overlay/الحالة) ففي useBtwSideChannel + BtwOverlay.
 *
 * البادئة تتطلّب مسافة لاحقة: «/btw <سؤال>» أو مرادف Codex
 * «/side <سؤال>». «/btwx» والأمر وحده بلا سؤال ليسا صالحين.
 * التطابق غير حسّاس لحالة الأحرف في كلمة الأمر تسامحاً.
 */

/** بادئة الأمر — تتطلّب مسافة بعد «/btw» وسؤالاً غير فارغ بعدها. */
export const BTW_PREFIX = '/btw ';
export const SIDE_PREFIX = '/side ';
const SIDE_CHANNEL_PREFIXES = [BTW_PREFIX, SIDE_PREFIX] as const;

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
  const normalized = leadingTrimmed.toLowerCase();
  const prefix = SIDE_CHANNEL_PREFIXES.find((candidate) => normalized.startsWith(candidate));
  return prefix ? leadingTrimmed.slice(prefix.length).trim() : '';
}

/** صحيحٌ فقط لأمر «/btw <سؤال غير فارغ>» جيّد التكوين. */
export function isBtwCommand(input: string): boolean {
  return parseBtwQuestion(input).length > 0;
}

/**
 * Provider-aware alias gate: `/btw` is shared by Claude and Codex, while
 * Codex's native `/side` spelling must never be intercepted in Claude.
 */
export function isSideChannelCommandForProvider(input: string, provider: string): boolean {
  if (!isBtwCommand(input)) {
    return false;
  }
  const normalized = input.replace(/^\s+/, '').toLowerCase();
  return normalized.startsWith(BTW_PREFIX) || provider === 'codex';
}

/**
 * Identifies a provider's reserved side-command token before validating a
 * session or question. This prevents malformed side input becoming a prompt.
 */
export function isReservedSideChannelCommandForProvider(input: string, provider: string): boolean {
  if (typeof input !== 'string') return false;
  const token = input.trimStart().split(/\s/u, 1)[0]?.toLowerCase();
  return ((provider === 'claude' || provider === 'codex') && token === '/btw')
    || (provider === 'codex' && token === '/side');
}
