// دوالّ نقية لعرض **نوافذ حصّة المزوّد** كما يعلنها المزوّد نفسه
// (‏`GET /api/providers/:provider/quota`). لا React ولا i18n ولا جلب.
//
// القاعدة الحاكمة: لا تسمية مستنتَجة. الخادم يمرّر مفتاح النافذة كما يسمّيه
// المزوّد (`primary`/`secondary` لكودكس، ‏`tokens1`/`tokens2`/`tools` لـglm) ولا
// يترجمها إلى «أسبوعي» أو «5 ساعات»، لأن طول النافذة يختلف بالخطة وترقيم
// `unit` عند z.ai غير موثَّق رسمياً. فما يُعرض هنا حقيقتان فقط: **النسبة
// المستهلكة** و**كم بقي حتى التصفير** — كلتاهما من الحمولة لا من تفسيرنا.
//
// ونافذةٌ مضى موعد تصفيرها تُحذَف: الرقم كان صحيحاً في نافذةٍ انتهت، وعرضه
// الآن يقول عن النافذة الجارية ما لا نعرفه (وهذا بالضبط ما أسقط ملاذَ اللقطة
// المحلية لكودكس: لقطة عمرها 18 يوماً ونوافذها مضت ⇒ لا شيء يُعرض).

/** نافذة واحدة كما تصل من الخادم. */
export type ProviderQuotaWindowRow = {
  key: string;
  /** النسبة **المستهلكة** 0-100 (مقصورة خادمياً). */
  usedPercent: number;
  resetsAt: string;
  /** طول النافذة بالثواني حين يرسله المزوّد (كودكس يرسله، ‏glm لا). */
  windowSeconds?: number;
};

export type ProviderQuotaPayload = {
  provider: string;
  plan: string | null;
  windows: ProviderQuotaWindowRow[];
  /** رصيد Codex الإضافي بوحدات المزوّد، بلا افتراض عملة. */
  extraUsageCredits?: {
    balance: number;
    unlimited: boolean;
  };
  observedAt?: string;
  source?: string;
};

/** نافذة جاهزة للعرض: أفقُ التصفير محسوب، ومضمونٌ أنه في المستقبل. */
export type QuotaWindowView = {
  key: string;
  usedPercent: number;
  resetsAt: string;
  windowSeconds?: number;
  /** كم بقي حتى التصفير: الوحدة الأكبر التي تُنتج رقماً ≥1. */
  horizon: { value: number; unit: 'minute' | 'hour' | 'day' };
};

const MS_PER_MINUTE = 60_000;
const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

/**
 * أفق التصفير بوحدة واحدة مقروءة. `null` إن مضى الموعد أو كان غير صالح —
 * والمستهلك يحذف النافذة حينها بدل عرض «بعد 0».
 */
export function resolveHorizon(
  resetsAt: string | null | undefined,
  nowMs: number,
): QuotaWindowView['horizon'] | null {
  const endMs = Date.parse(resetsAt ?? '');
  if (!Number.isFinite(endMs)) return null;

  const remaining = endMs - nowMs;
  if (remaining <= 0) return null;

  if (remaining >= MS_PER_DAY) {
    return { value: Math.ceil(remaining / MS_PER_DAY), unit: 'day' };
  }
  if (remaining >= MS_PER_HOUR) {
    return { value: Math.ceil(remaining / MS_PER_HOUR), unit: 'hour' };
  }
  return { value: Math.max(1, Math.ceil(remaining / MS_PER_MINUTE)), unit: 'minute' };
}

/**
 * النوافذ القابلة للعرض، مرتَّبة بالأقرب تصفيراً أولاً (وهي الأكثر إلحاحاً:
 * «نَفِدت وتُصفَّر بعد ساعتين» أنفع من حدٍّ شهري بعيد).
 *
 * تُحذَف: نسبةٌ غير رقمية، وموعدٌ غير صالح أو مضى. ولا تُكمَّل قيمة ناقصة بصفر
 * أبداً — الصفر يُقرأ «لم تستهلك شيئاً» وهو ادّعاء مختلف عن «لا نعرف».
 */
export function resolveQuotaWindows(
  payload: ProviderQuotaPayload | null | undefined,
  nowMs: number,
): QuotaWindowView[] {
  if (!payload || !Array.isArray(payload.windows)) return [];

  const views: QuotaWindowView[] = [];
  for (const row of payload.windows) {
    if (!row || typeof row.key !== 'string' || !row.key) continue;
    if (typeof row.usedPercent !== 'number' || !Number.isFinite(row.usedPercent)) continue;

    const horizon = resolveHorizon(row.resetsAt, nowMs);
    if (!horizon) continue;

    views.push({
      key: row.key,
      usedPercent: Math.max(0, Math.min(100, row.usedPercent)),
      resetsAt: row.resetsAt,
      ...(typeof row.windowSeconds === 'number' && Number.isFinite(row.windowSeconds)
        ? { windowSeconds: row.windowSeconds }
        : {}),
      horizon,
    });
  }

  return views.sort((a, b) => Date.parse(a.resetsAt) - Date.parse(b.resetsAt));
}

/**
 * اللحظة التي يتغيّر عندها أقرب أفق (لجدولة إعادة حساب واحدة لا استقصاء).
 * `null` = لا نوافذ ⇒ لا مؤقّت. نفس منطق `nextCountdownTickMs` في دورة
 * الفوترة: تُشتقّ من موعد التصفير لا من ساعة المتصفّح.
 */
export function nextQuotaTickMs(views: readonly QuotaWindowView[], nowMs: number): number | null {
  let soonest: number | null = null;
  for (const view of views) {
    const endMs = Date.parse(view.resetsAt);
    if (!Number.isFinite(endMs) || endMs <= nowMs) continue;

    const remaining = endMs - nowMs;
    const step =
      remaining >= MS_PER_DAY ? MS_PER_DAY : remaining >= MS_PER_HOUR ? MS_PER_HOUR : MS_PER_MINUTE;
    // اللحظة التي ينقص عندها هذا الأفق بواحد، بنفس وحدته الحالية.
    const units = Math.ceil(remaining / step);
    const tick = endMs - (units - 1) * step + 1_000;
    if (soonest === null || tick < soonest) soonest = tick;
  }
  return soonest;
}

/**
 * تصنيف النافذة بطولها — وهو ما **تُسمّى** به الشارة.
 *
 * **المصطلح موحَّد على كل المزوّدات** (قرار المالك 2026-07-30): نافذة الجلسة
 * (خمس ساعات عملياً عند كلود وglm) هي `C`، والأسبوعية `W`، والشهرية `M` — نفس
 * حروف نوافذ كلود القائمة، فلا يتعلّم القارئ مفردتين لشيء واحد.
 *
 * والفرق الذي جاء البلاغ عنه قبلها: الشارة كانت تحمل **أفق التصفير** فيُقرأ
 * طولاً («7س 29%» كانت النافذة الأسبوعية التي يتبقّى لتصفيرها سبع ساعات).
 * فالحرف للطول، والأفق في التلميح.
 *
 * تُعاد بيانات خام (لا نصّ مترجَم) ليتولّى المكوّن i18n: الحرف للشارة، والوصف
 * الكامل (‏«5س»/«أسبوع»/«شهر») للتلميح.
 */
export type WindowLengthKind = 'session' | 'week' | 'month' | 'hours' | 'days' | 'minutes';

export type WindowLength = {
  kind: WindowLengthKind;
  /** ساعات الجلسة، أو عدد الوحدات في الأشكال غير القياسية. */
  value?: number;
  /** حرف الشارة الموحَّد، أو `null` لطولٍ غير قياسي فتُوسَم بعددها. */
  letter: 'C' | 'W' | 'M' | null;
};

const HOUR = 3_600;
const DAY = 86_400;

export function resolveWindowLength(
  windowSeconds: number | null | undefined,
): WindowLength | null {
  if (typeof windowSeconds !== 'number' || !Number.isFinite(windowSeconds) || windowSeconds <= 0) {
    return null;
  }

  // نافذة الجلسة: كل ما دون اليوم. عملياً خمس ساعات عند كلود وz.ai، لكن الحدّ
  // بالطول لا بالرقم كي لا ينكسر الوسم على خطةٍ بنافذة ثلاث ساعات أو ست.
  if (windowSeconds < DAY) {
    return { kind: 'session', value: Math.max(1, Math.round(windowSeconds / HOUR)), letter: 'C' };
  }

  // الأسبوع والشهر بسماحٍ حول القيمة: المزوّدون يرسلون 7 أيام بالثانية بالضبط،
  // والشهر 30 أو 31 يوماً، فالمساواة الحرفية كانت ستُسقط الوسم بلا سبب.
  if (windowSeconds >= 6 * DAY && windowSeconds <= 8 * DAY) {
    return { kind: 'week', letter: 'W' };
  }
  if (windowSeconds >= 27 * DAY && windowSeconds <= 32 * DAY) {
    return { kind: 'month', letter: 'M' };
  }

  // طولٌ غير قياسي (خطة بأسبوعين مثلاً): يُوسَم بعدده لا بحرفٍ يكذب.
  return { kind: 'days', value: Math.round(windowSeconds / DAY), letter: null };
}

/**
 * هل معرّف النموذج يدلّ على **حساب Anthropic**؟ فحصٌ محليّ صغير مقصود الحدود:
 * الخادم هو الحاكم (`resolveModelVendor`) وهذا احتياطٌ لحالتين واقعيتين:
 *
 *  1. **نافذة ما قبل إعادة التشغيل**: العميل يُنشَر بـ`build:client` وحده بينما
 *     الخادم لم يُحمَّل بعد، فلا يعرف كود `PROVIDER_QUOTA_ANTHROPIC`. بلا هذا
 *     الاحتياط كانت نوافذ كلود **تختفي** في تلك النافذة على جلسة كلود عادية —
 *     انحدارٌ يصيب المسار الأكثر استخداماً.
 *  2. اسمٌ مختصر لا يُحلّه الخادم (`opus`, `sonnet`) فيبقى المعروف معروفاً.
 *
 * القائمة أسماء عائلة Anthropic حصراً؛ وأي شيء آخر **لا** يُعَدّ كلوداً — فالخطأ
 * في هذا الاتجاه (صمت) أرحم من الخطأ في الاتجاه الآخر (عرض حصّة اشتراك لا
 * يُستهلك منه شيء، وهو البلاغ الذي جاء أصلاً).
 */
const ANTHROPIC_MODEL_HINTS = ['claude', 'opus', 'sonnet', 'haiku', 'fable'];

export function looksLikeAnthropicModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const value = model.trim().toLowerCase();
  if (!value) return false;
  // بادئة مورّد صريحة تحسم ضدّه: `glm/glm-5.2` ليس كلوداً وإن حوى اسماً مشابهاً.
  const slash = value.indexOf('/');
  const head = slash > 0 ? value.slice(0, slash) : '';
  if (head && head !== 'anthropic' && head !== 'claude') return false;
  const bare = slash > 0 ? value.slice(slash + 1) : value;
  return ANTHROPIC_MODEL_HINTS.some((hint) => bare.includes(hint));
}

/**
 * حارس الصمت على سطح `provider-windows` أثناء idle/loading.
 *
 * **المشكلة التي يحلّها (B-1290 follow-up):** `useProviderCycles` لا يُعيد
 * ضبط حالته عند تعطيل `enabled` (السلوك المقصود: لا بياناتٍ بائتة ظاهرة عند
 * إعادة التفعيل). لكن إذا تحوّل `providerQuota.status` من `error` إلى
 * `loading` (إعادة المحاولة بعد 180ث)، فإن `cycleFallbackResolved` يصبح
 * `false` مما يُعطّل `useProviderCycles` — غير أن الدالة تُبقي صفوف الدورة
 * السابقة، فيبقى `cycle` غير null، ويظهر «↻ Nي» في بقعة مؤشّر الحصّة
 * لمدة الطلب. هذه الدالة الخالصة الواحدة تُكرَّر في السطحَين (الهيدر
 * والشريط الجانبي) لتقطع هذا المسار بدل نسخ الشرط يدوياً.
 *
 * true ⇒ اصمت (لا تعرض شارة الدورة ولا أي شيء آخر).
 * false ⇒ تابع — حالات error/none/anthropic/success تُعالَج بعدها.
 */
export function shouldSuppressOnProviderWindowsLoading(
  surface: string,
  quotaStatus: string,
): boolean {
  return surface === 'provider-windows' && (quotaStatus === 'idle' || quotaStatus === 'loading');
}
