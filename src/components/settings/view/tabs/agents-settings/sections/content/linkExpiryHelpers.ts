/**
 * دوالّ نقية لحساب نبرة ظهور قرب انتهاء صلاحية الربط.
 *
 * مرآةٌ لـ`providerCycleHelpers`: لا React، لا i18n، لا DOM — القواعد
 * التي تحدّد ما يُعرَض وبأيّ نبرة تعيش هنا كي تُختبَر بمعزل.
 *
 * القاعدة الحاكمة:
 *  • الموعد يُعرض **دائماً** ما دام الخادم يعرفه — لا عند الخطر وحده. حجبُه
 *    خارج نافذة التحذير كان يجعل تسجيلَ دخولٍ ناجحاً يبدو بلا أثر: يُجدّد العضو
 *    فيختفي السطر بدل أن يُظهر الموعد الجديد.
 *  • `daysLeft: 0` = «ينتهي اليوم» لا «انتهى».
 *  • `daysLeft > 3` ⇒ neutral: خبرٌ لا إنذار، بنبرة السطر المجاور نفسها.
 *  • `daysLeft 2..3` ⇒ warning (نافذةُ الـCLI نفسها، فلا نُنذر قبله).
 *  • `daysLeft <= 1` ⇒ danger (يتطلّب bold في العرض).
 */

/** حدُّ نبرة التحذير — ثابتُ الـCLI نفسه. */
export const LINK_EXPIRY_WARNING_DAYS = 3;

/**
 * لحظةُ انتهاء الربط منسَّقةً للعرض.
 *
 * الوقتُ هنا **حقيقيٌّ** لا مُصطنَع: ختمُ OAuth مضبوطٌ إلى الثانية. وهذا ما
 * يفرّقه عن موعد تجديد الاشتراك المحسوب على منتصف ليل يوم المرساة
 * (`resolveBillingCycle` ⇐ `new Date(y, m, d, 0, 0, 0, 0)`) — فذاك صفرٌ
 * اصطلاحيٌّ لا ساعةُ فوترة، وعرضُه «12:00 ص» اختراعٌ لا معلومة.
 *
 * والمنطقةُ معروضةٌ لا مضمرة: ساعةٌ بلا منطقةٍ تُقرأ على منطقة القارئ حتماً،
 * والحقلُ يأتي من ختمٍ بتوقيت UTC. و`timeZone` غيرُ ممرَّرٍ افتراضاً كي يحلّها
 * `Intl` إلى منطقة **الجهاز** — فالعضو يقرأ الموعد بساعته هو. ويُترك الفاصلُ
 * بين التاريخ والوقت لـ`Intl` كي يصحّ في كل لغة بدل ترقيمٍ مثبّت.
 */
export function formatExpiryMoment(
  isoString: string,
  locale: string,
  timeOnly: boolean,
  timeZone?: string,
): string {
  const date = new Date(isoString);
  const sameYear = date.getFullYear() === new Date().getFullYear();
  return new Intl.DateTimeFormat(locale, {
    ...(timeOnly
      ? {}
      : { month: 'long', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) }),
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
    ...(timeZone ? { timeZone } : {}),
  }).format(date);
}

export type LinkExpiryPayload = {
  expiresAt: string;
  daysLeft: number;
};

export type LinkExpiryDisplay = {
  /** انقضاءٌ بعد الموعد، خطرٌ في اليوم الأخير، تحذيرٌ داخل النافذة، وحيادٌ بعدها. */
  tone: 'expired' | 'danger' | 'warning' | 'neutral';
  daysLeft: number;
  expiresAt: string;
};

/**
 * يُحوِّل حمولة انتهاء الربط إلى قرار عرض.
 * `null` ⇒ `null`: لا يُعرض شيء (الخادم خارج نافذة الثلاثة أيام، أو مسار مفتاح).
 */
export function resolveLinkExpiryDisplay(
  linkExpiry: LinkExpiryPayload | null | undefined,
  nowMs: number,
): LinkExpiryDisplay | null {
  if (!linkExpiry) return null;

  // الموعدُ المُنقضي لا يقطع الاتصال — توكنُ الوصول يبقى حيّاً ساعاتٍ بعده —
  // لكن «ينتهي اليوم 3:49م» بعد الرابعة كذبةٌ صغيرة تُفوّت الفعلَ المطلوب.
  // ولهذا تُمرَّر الساعةُ ولا تُقرأ داخلاً: العدّادُ يجب أن يكون قابلاً للتثبيت.
  if (Date.parse(linkExpiry.expiresAt) <= nowMs) {
    return { tone: 'expired', daysLeft: 0, expiresAt: linkExpiry.expiresAt };
  }

  const { daysLeft } = linkExpiry;
  const tone = daysLeft <= 1
    ? 'danger'
    : daysLeft <= LINK_EXPIRY_WARNING_DAYS ? 'warning' : 'neutral';

  return { tone, daysLeft, expiresAt: linkExpiry.expiresAt };
}
