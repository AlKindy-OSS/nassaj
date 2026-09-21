// دوالّ نقية لعرض **دورة فوترة المزوّد** في سطح دائم الظهور (الشريط العلوي
// والشريط الجانبي المطويّ). لا React ولا i18n ولا جلب — القواعد التي تحدّد ما
// يُسمح للسطح أن يقوله تعيش هنا كي تُختبر بلا DOM، على سابقة
// `subscriptionHelpers.ts`.
//
// ثلاث قواعد صدق تحكم هذا الملف، وكلّها جاءت من فيتو المراجعة النقدية:
//
//  • **لا مبلغ أبداً.** عقد `/costs/cycle` لا يحمل مبلغاً أصلاً (ولا `metered`
//    ولا `available`)، فليس هنا ما يُطبَع كرقم مالي. السبب: لاشتراك ثابت يكون
//    المبلغ «قيمةً مكافئة بأسعار API لا مالاً مفوتَراً»، وسطرٌ في هيدر لا
//    يتّسع لهذا التحفّظ ولا لختم `pricesAsOf` يُقرأ فاتورةً.
//  • **لا موعد من مرساة مقدَّرة.** ‏`anchorSource` يقول من أين جاء يوم
//    التجديد: `detected` من بيانات الاشتراك نفسها، و`manual` من المالك، أمّا
//    `derived` فتقديرٌ من أقدم استهلاك مرئي و`unknown` فشهرٌ تقويمي مفترَض.
//    الأخيران يُخفَيان: «يتجدّد بعد 3 أيام» مبنيّاً على افتراضٍ موعدٌ مختلق.
//  • **الغياب غياب.** لا صفّ للمزوّد (غير مُصادَق عليه، أو أخفاه المالك) ⇒ لا
//    شيء يُعرض. لا «0» ولا «غير معروف» — كلاهما ادّعاء.

/** صفّ واحد من `GET /api/providers/costs/cycle` (مطابق لـProviderBillingCycle خادمياً). */
export type ProviderCycleRow = {
  /** مُعرِّف الجسم: claude، codex، glm… وهو نفس النصّ الذي يحمله الهيدر أصلاً. */
  provider: string;
  displayName: string;
  plan: string | null;
  anchorDay: number;
  anchorSource: 'manual' | 'detected' | 'derived' | 'unknown';
  cycleStart: string;
  cycleEnd: string;
};

/** ما يُسمح للسطح بعرضه. `null` من `resolveCycleDisplay` = لا يُعرض شيء. */
export type CycleDisplay = {
  /** أيام كاملة متبقّية حتى نهاية الدورة (‏0 = اليوم). */
  daysRemaining: number;
  /** نهاية الدورة كما وصلت (‏ISO) — للتلميح لا للحساب في المكوّن. */
  renewsAt: string;
  /** اسم الخطة إن أعلنه المصدر (‏Plus، ‏Max 20x…) — قد يكون null. */
  plan: string | null;
  /** مصدر المرساة، ليُقال في التلميح: مكتشَفة أم كتبها المالك. */
  anchorSource: 'manual' | 'detected';
};

/**
 * مصادر المرساة التي يجوز بناء موعد عليها. `derived`/`unknown` مستبعدان عمداً:
 * الرقم نفسه، والادّعاء مختلف — والفرق هو كل شيء في سطر يقول «يتجدّد بعد N».
 */
const TRUSTED_ANCHOR_SOURCES = new Set(['detected', 'manual']);

const MS_PER_DAY = 86_400_000;

/**
 * صفّ المزوّد المطلوب. المطابقة على **الجسم** لا المورّد: العقد مفتاحه الجسم
 * (‏claude/codex/glm)، وهو نفس النصّ الذي يحمله السطح أصلاً — فلا حاجة لنسخة
 * عميلية من `model-vendor.ts` (وهي نسخة كانت ستتعفّن مع أول مورّد جديد).
 */
export function findCycleRow(
  rows: readonly ProviderCycleRow[] | null | undefined,
  provider: string | null | undefined,
): ProviderCycleRow | null {
  if (!rows || !provider) return null;
  const key = provider.trim().toLowerCase();
  if (!key) return null;
  return rows.find((row) => row.provider?.trim().toLowerCase() === key) ?? null;
}

/**
 * ما يُعرض لهذا الصفّ، أو `null` إن كان الصمت هو الجواب الصادق.
 *
 * `nowMs` مُمرَّر لا مقروء من الساعة داخلاً: عدّاد الأيام يجب أن يكون قابلاً
 * للتثبيت في الاختبار وأن يُعاد حسابه عند عبور منتصف الليل في تبويب مفتوح.
 */
export function resolveCycleDisplay(
  row: ProviderCycleRow | null | undefined,
  nowMs: number,
): CycleDisplay | null {
  if (!row) return null;
  if (!TRUSTED_ANCHOR_SOURCES.has(row.anchorSource)) return null;

  const endMs = Date.parse(row.cycleEnd ?? '');
  if (!Number.isFinite(endMs)) return null;

  // نهاية مضت (تبويب مفتوح عبر حدّ الدورة قبل أن يُحدَّث الجلب) ⇒ لا رقم:
  // «بعد ‎-1 يوم» أو «بعد 0» على دورة انتهت كلاهما يقول ما لا نعرفه.
  if (endMs <= nowMs) return null;

  return {
    daysRemaining: Math.ceil((endMs - nowMs) / MS_PER_DAY),
    renewsAt: row.cycleEnd,
    plan: row.plan ?? null,
    anchorSource: row.anchorSource as 'manual' | 'detected',
  };
}

/**
 * اللحظة التي ينقص عندها عدّاد الأيام، لجدولة إعادة حساب **واحدة** بدل استقصاء
 * دوري: تبويب مفتوح كان سيُظهر «بعد 3 أيام» إلى الأبد.
 *
 * تُحسَب من نهاية الدورة لا من منتصف ليل المتصفّح: العدّاد `ceil` لما بقي من
 * زمن حتى لحظةٍ مطلقة، فهو ينقص عند `end - (n-1)×يوم` — وهي لحظة لا تُصادف
 * منتصف ليل القارئ إلا إن كان في منطقة الخادم. الاعتماد على منتصف ليل محلّي
 * كان سيُخطئ التوقيت بساعات في كل منطقة أخرى (وهي ملاحظة M-12 في المراجعة).
 *
 * الهامش (+1s) يضمن أن إعادة الحساب تقع **بعد** الحدّ لا عليه بالضبط.
 */
export function nextCountdownTickMs(endMs: number, nowMs: number): number {
  const days = Math.ceil((endMs - nowMs) / MS_PER_DAY);
  return endMs - (days - 1) * MS_PER_DAY + 1_000;
}
