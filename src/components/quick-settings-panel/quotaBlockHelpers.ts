/**
 * اختيار حصار الحصة الفعّال وصياغة مهلته (T-1191) — دوالّ نقية بلا React.
 *
 * فُصلت عن المكوّن لأن قرار «هل يُعرض شيء أصلاً؟» هو موضع الخطأ الحقيقي هنا،
 * ويجب أن يكون قابلاً للاختبار بلا تركيب شجرة. نفس ترتيب `providerCycleHelpers`.
 */

import type { ProviderQuotaBlock } from './hooks/useProviderCycles';

export type ActiveQuotaBlock = {
  provider: string;
  resetsAtMs: number;
  reason: string;
  msRemaining: number;
};

/**
 * يُعيد حصار المزوّد المطلوب إن كان قائماً **الآن**، وإلّا null.
 *
 * يُعاد فحص انقضاء المهلة هنا رغم أن الخادم فحصها: بين جلبٍ وآخر تمرّ دقائق
 * (الهوك يجلب مرّة ولا يستقصي)، فحصارٌ انتهى بعد الجلب يبقى في الحالة العميلية.
 * بلا هذا الفحص يبقى العدّاد معروضاً بعد تجدّد الحصة فعلاً — وهو أسوأ من عدم
 * عرضه: يمنع المستخدم من محاولةٍ صارت ناجحة.
 *
 * وطابعٌ زمنيٌّ غير صالح يُقرأ «لا حصار» لا «حصارٌ منتهٍ»: القيمة التي لا نفهمها
 * لا يُبنى عليها ادّعاء في أيّ اتجاه.
 */
export function selectActiveQuotaBlock(
  blocks: ProviderQuotaBlock[] | null | undefined,
  provider: string | null,
  nowMs: number
): ActiveQuotaBlock | null {
  if (!provider || !Array.isArray(blocks) || blocks.length === 0) return null;

  const match = blocks.find((block) => block?.provider === provider);
  if (!match || typeof match.resetsAt !== 'string') return null;

  const resetsAtMs = Date.parse(match.resetsAt);
  if (Number.isNaN(resetsAtMs)) return null;

  const msRemaining = resetsAtMs - nowMs;
  if (msRemaining <= 0) return null;

  return {
    provider: match.provider,
    resetsAtMs,
    reason: typeof match.reason === 'string' ? match.reason : '',
    msRemaining,
  };
}

export type QuotaCountdownParts =
  | { unit: 'days'; value: number }
  | { unit: 'hours'; value: number }
  | { unit: 'minutes'; value: number };

/**
 * يختار **وحدةً واحدة** للعدّاد المضغوط في الشريط العلوي.
 *
 * وحدة واحدة لا اثنتان («٣ي» لا «٣ي ٤س»): السطر في الهيدر ضيّق، والدقّة الزائدة
 * هنا بلا قيمة قرارية — من يرى «بعد ٣ أيام» لا يغيّر فعله لو كانت ٣ أيام وأربع
 * ساعات. والموعد الدقيق متاح في التلميح.
 *
 * والتقريب **لأعلى** (`ceil`) مقصود: «بعد ساعة» لتسع وخمسين دقيقة أصدق من «بعد
 * ٠ ساعة»، ولا يَعِد المستخدم بلحظةٍ تسبق التجدّد الفعلي فيحاول قبل أوانه.
 */
export function quotaCountdownParts(msRemaining: number): QuotaCountdownParts {
  const minutes = Math.ceil(msRemaining / 60_000);
  if (minutes < 60) return { unit: 'minutes', value: Math.max(1, minutes) };

  const hours = Math.ceil(msRemaining / 3_600_000);
  if (hours < 24) return { unit: 'hours', value: hours };

  return { unit: 'days', value: Math.ceil(msRemaining / 86_400_000) };
}
