/**
 * جدول الأسعار الرسمية لكل نموذج — مصدر واحد للحقيقة، مؤرَّخ ومنسوب.
 *
 * ⚠️ الأسعار تتغيّر. `PRICES_AS_OF` تُعرَض في الواجهة بجانب أي مبلغ، فما يظهر
 * للمستخدم مؤرَّخ لا مُطلَق. عند التحديث: غيّر التاريخ في نفس الـcommit.
 *
 * كل رقم أدناه مقروء من مصدر المزوّد الرسمي بتاريخ 2026-07-28 (المصادر في
 * تعليق كل عائلة)، و**لا صفّ اليوم يحمل `assumed`** — الآلية باقية في النوع
 * لنموذج قد يظهر مستقبلاً بلا سعر منشور، فيُعرَض حينها تقديراً مسمّى وتصير
 * البطاقة «جزئية». والنموذج غير المُسعَّر أصلاً يُترك خارج الجدول ويُعرَض
 * «سعره غير متاح» بدل تلفيق صفر.
 *
 * ── فروق دلالية بين المزوّدات (فخّ حقيقي، لا تفصيل شكلي) ───────────────────
 *
 *  • **أنثروبيك**: ‏`input` لا يشمل المخبّأ. الكتابة إلى المخبّأ بندٌ مستقلّ
 *    (‏5 دقائق = 1.25× المدخلات، ساعة = 2×)، والقراءة = 0.1×.
 *
 *  • **OpenAI**: لا تقسيم 5د/ساعة إطلاقاً. القراءة من المخبّأ = 10% من سعر
 *    المدخلات، والكتابة مجّانية في أغلب العائلة (‏0) عدا عائلة 5.6.
 *    و`input_tokens` لديها **شامل** للمخبّأ (يتولّى المُستخرِج طرحه).
 *
 *  • **جوجل**: لا رسم كتابة إلى المخبّأ أصلاً؛ التخزين يُحاسَب بالساعة
 *    (بُعد لا يُشتقّ من عدّاد توكنز محادثة) ⇒ لا يُحتسَب هنا، ويُذكَر نقصاً.
 */

export type ModelPrice = {
  /** المدخلات غير المخبّأة، دولار لكل مليون توكن. */
  inputPerMTok: number;
  outputPerMTok: number;
  /** كتابة إلى المخبّأ (عمر 5 دقائق لدى أنثروبيك، والسعر الوحيد لدى غيرها). */
  cacheWrite5mPerMTok: number | null;
  /** كتابة إلى المخبّأ بعمر ساعة — أنثروبيك وحدها. */
  cacheWrite1hPerMTok: number | null;
  cacheReadPerMTok: number | null;
  /**
   * `true` = السعر **مفترَض بالقياس على عائلته**، لا مقروءاً من صفحة رسمية.
   *
   * لا يجوز أن يمرّ مثل هذا الرقم كأنه مقيس: نماذج غير معلَنة تظهر في سجلّاتنا
   * (‏fable-5 يشكّل ~27% من أكبر بطاقة) ولا صفحة تسعير لها تُقرأ — والمستودع
   * نفسه يصف fable-5 بأنه غير مُصدَر (‏claude-models.provider.ts). فيبقى السعر
   * لأنه أقرب تقدير متاح، ويُرفَع علمه فتصير البطاقة «جزئية» ويُسمّى النموذج.
   */
  assumed?: boolean;
  /**
   * تغيير سعر **مجدول ومعلَن** لهذا النموذج.
   *
   * سعرٌ ترويجي ينتهي هو قنبلة موقوتة صامتة: الجدول يبقى صحيحاً حتى يوم
   * الانتهاء ثم يبخس الكلفة بلا أي إشارة. سونيت 5 مثالها الحيّ — ‏$2/$10
   * ترويجي حتى 2026-08-31، ثم $3/$15، أي أن الرقم المعروض بعدها سيكون أقلّ
   * من الحقيقة بالثلث. فيُسجَّل التغيير هنا وقت معرفته لا وقت وقوعه.
   */
  scheduled?: { effectiveFrom: string } & Omit<ModelPrice, 'assumed' | 'scheduled'>;
};

/** تاريخ قراءة الأسعار من صفحات المزوّدين الرسمية. يُعرَض مع كل مبلغ. */
export const PRICES_AS_OF = '2026-07-28';

/**
 * أنثروبيك — platform.claude.com/docs/en/about-claude/pricing
 * مضاعفات المخبّأ رسمية ومطّردة: 5د = 1.25× المدخلات، ساعة = 2×، قراءة = 0.1×.
 */
const ANTHROPIC_PRICES: Record<string, ModelPrice> = {
  // ‏fable-5 و mythos-5: ‏$10/$50 — **ضعف opus-4-8 بالضبط**، وهو سعر رسمي
  // منشور في كتالوج النماذج لا تقديراً. (وُسِما `assumed` خطأً في مراجعة سابقة
  // بناءً على تعليق في claude-models.provider.ts؛ وذاك التعليق يخصّ **منتقي
  // النماذج** — يُخفيهما لأن الاشتراك قد لا يكون مخوَّلاً باختيارهما — ولا
  // علاقة له بالتسعير. وfable-5 مستعمَل فعلاً على هذا الجهاز.)
  'claude-fable-5': { inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 1 },
  'claude-mythos-5': { inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5, cacheWrite1hPerMTok: 20, cacheReadPerMTok: 1 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-8': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-7': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-6': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-5': { inputPerMTok: 5, outputPerMTok: 25, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: 10, cacheReadPerMTok: 0.5 },
  'claude-opus-4-1': { inputPerMTok: 15, outputPerMTok: 75, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30, cacheReadPerMTok: 1.5 },
  'claude-opus-4': { inputPerMTok: 15, outputPerMTok: 75, cacheWrite5mPerMTok: 18.75, cacheWrite1hPerMTok: 30, cacheReadPerMTok: 1.5 },
  // ‏$2/$10 **ترويجي** ينتهي 2026-08-31؛ السعر المعلَن بعده $3/$15 (وهو نفسه
  // سعر sonnet-4-6 — مرساة تحقّق مفيدة). مسجَّل الآن كي لا يُبخَس الحساب صامتاً.
  'claude-sonnet-5': {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheWrite5mPerMTok: 2.5,
    cacheWrite1hPerMTok: 4,
    cacheReadPerMTok: 0.2,
    scheduled: {
      effectiveFrom: '2026-09-01',
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheWrite5mPerMTok: 3.75,
      cacheWrite1hPerMTok: 6,
      cacheReadPerMTok: 0.3,
    },
  },
  'claude-sonnet-4-6': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 },
  'claude-sonnet-4-5': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 },
  'claude-sonnet-4': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: 3.75, cacheWrite1hPerMTok: 6, cacheReadPerMTok: 0.3 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: 2, cacheReadPerMTok: 0.1 },
  'claude-3-5-haiku': { inputPerMTok: 0.8, outputPerMTok: 4, cacheWrite5mPerMTok: 1, cacheWrite1hPerMTok: 1.6, cacheReadPerMTok: 0.08 },
};

/**
 * OpenAI — developers.openai.com (‏pricing + prompt-caching).
 * القراءة من المخبّأ = 10% من المدخلات. الكتابة مجّانية عدا عائلة 5.6.
 */
const OPENAI_PRICES: Record<string, ModelPrice> = {
  'gpt-5.6-sol': { inputPerMTok: 5, outputPerMTok: 30, cacheWrite5mPerMTok: 6.25, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.5 },
  'gpt-5.6-terra': { inputPerMTok: 2.5, outputPerMTok: 15, cacheWrite5mPerMTok: 3.125, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.25 },
  'gpt-5.6-luna': { inputPerMTok: 1, outputPerMTok: 6, cacheWrite5mPerMTok: 1.25, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.1 },
  'gpt-5.5-pro': { inputPerMTok: 30, outputPerMTok: 180, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: null },
  'gpt-5.5': { inputPerMTok: 5, outputPerMTok: 30, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.5 },
  'gpt-5.4-pro': { inputPerMTok: 30, outputPerMTok: 180, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: null },
  'gpt-5.4-mini': { inputPerMTok: 0.75, outputPerMTok: 4.5, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.075 },
  'gpt-5.4-nano': { inputPerMTok: 0.2, outputPerMTok: 1.25, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.02 },
  'gpt-5.4': { inputPerMTok: 2.5, outputPerMTok: 15, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.25 },
  'gpt-5.3-codex': { inputPerMTok: 1.75, outputPerMTok: 14, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.175 },
  'gpt-5.2-pro': { inputPerMTok: 21, outputPerMTok: 168, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: null },
  'gpt-5.2-codex': { inputPerMTok: 1.75, outputPerMTok: 14, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.175 },
  'gpt-5.2': { inputPerMTok: 1.75, outputPerMTok: 14, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.175 },
  'gpt-5.1-codex-max': { inputPerMTok: 1.25, outputPerMTok: 10, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.125 },
  'gpt-5.1-codex': { inputPerMTok: 1.25, outputPerMTok: 10, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.125 },
  'gpt-5.1': { inputPerMTok: 1.25, outputPerMTok: 10, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.125 },
};

/**
 * جوجل — ai.google.dev/gemini-api/docs/pricing. لا رسم كتابة إلى المخبّأ؛
 * `cacheWrite*` صفر لا null: الصفر هنا حقيقة تسعير لا نقص بيانات.
 */
const GOOGLE_PRICES: Record<string, ModelPrice> = {
  'gemini-3.1-pro-preview': { inputPerMTok: 2, outputPerMTok: 12, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.2 },
  'gemini-3.6-flash': { inputPerMTok: 1.5, outputPerMTok: 7.5, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.15 },
  'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.03 },
  'gemini-3.5-flash': { inputPerMTok: 1.5, outputPerMTok: 9, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.15 },
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.025 },
  'gemini-3-flash-preview': { inputPerMTok: 0.5, outputPerMTok: 3, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.05 },
  'gemini-2.5-pro': { inputPerMTok: 1.25, outputPerMTok: 10, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.125 },
  'gemini-2.5-flash-lite': { inputPerMTok: 0.1, outputPerMTok: 0.4, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.01 },
  'gemini-2.5-flash': { inputPerMTok: 0.3, outputPerMTok: 2.5, cacheWrite5mPerMTok: 0, cacheWrite1hPerMTok: 0, cacheReadPerMTok: 0.03 },
};

/** Moonshot ‏(Kimi) — platform.kimi.ai/docs/models. عائلة k2 أُوقفت 2026-05-25. */
const MOONSHOT_PRICES: Record<string, ModelPrice> = {
  'kimi-k3': { inputPerMTok: 3, outputPerMTok: 15, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.3 },
  'kimi-k2.7-code-highspeed': { inputPerMTok: 1.9, outputPerMTok: 8, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.38 },
  'kimi-k2.7-code': { inputPerMTok: 0.95, outputPerMTok: 4, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.19 },
  'kimi-k2.6': { inputPerMTok: 0.95, outputPerMTok: 4, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.16 },
  'kimi-k2.5': { inputPerMTok: 0.6, outputPerMTok: 3, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.1 },
  'moonshot-v1-128k': { inputPerMTok: 2, outputPerMTok: 5, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: null },
  'moonshot-v1-32k': { inputPerMTok: 1, outputPerMTok: 3, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: null },
  'moonshot-v1-8k': { inputPerMTok: 0.2, outputPerMTok: 2, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: null },
};

/** DeepSeek — api-docs.deepseek.com/quick_start/pricing. */
const DEEPSEEK_PRICES: Record<string, ModelPrice> = {
  'deepseek-v4-flash': { inputPerMTok: 0.14, outputPerMTok: 0.28, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.0028 },
  'deepseek-v4-pro': { inputPerMTok: 0.435, outputPerMTok: 0.87, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.003625 },
};

/** Z.ai ‏/ GLM — docs.z.ai. */
const GLM_PRICES: Record<string, ModelPrice> = {
  'glm-5.2': { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.26 },
  'glm-5.1': { inputPerMTok: 1.4, outputPerMTok: 4.4, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.26 },
  'glm-5-turbo': { inputPerMTok: 1.2, outputPerMTok: 4, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.24 },
  'glm-5': { inputPerMTok: 1, outputPerMTok: 3.2, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.2 },
  'glm-4.7-flashx': { inputPerMTok: 0.07, outputPerMTok: 0.4, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.01 },
  'glm-4.7': { inputPerMTok: 0.6, outputPerMTok: 2.2, cacheWrite5mPerMTok: null, cacheWrite1hPerMTok: null, cacheReadPerMTok: 0.11 },
};

export const MODEL_PRICES: Record<string, ModelPrice> = {
  ...ANTHROPIC_PRICES,
  ...OPENAI_PRICES,
  ...GOOGLE_PRICES,
  ...MOONSHOT_PRICES,
  ...DEEPSEEK_PRICES,
  ...GLM_PRICES,
};

/**
 * المفاتيح مرتَّبة تنازلياً بالطول: المطابقة بالبادئة يجب أن تُفضّل الأخصّ
 * ('gpt-5.1-codex-max' قبل 'gpt-5.1'، و'claude-opus-4-5' قبل 'claude-opus-4').
 */
const PRICE_KEYS_BY_SPECIFICITY = Object.keys(MODEL_PRICES).sort((a, b) => b.length - a.length);

/**
 * يوحّد اسم النموذج كما يظهر في السجلّات قبل المطابقة:
 *  - إسقاط لصيقة التاريخ (`claude-opus-4-5-20251101` ⇒ `claude-opus-4-5`).
 *  - إسقاط بادئات التوجيه (‏`anthropic/`، `openai/`، `us.anthropic.`) التي
 *    يضيفها الحاملون (OpenCode وغيره) حول اسم النموذج الأصلي.
 *  - إسقاط لواحق الجهد التي يضيفها Cursor (`-high`، `-medium`) — الجهد لا
 *    يغيّر سعر التوكن.
 */
export function normalizeModelId(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/^(?:us|eu|apac)\./, '')
    .replace(/^[a-z0-9-]+\//, '')
    .replace(/-\d{8}$/, '')
    .replace(/-(?:latest|preview)$/, '')
    .replace(/-(?:low|medium|high|xhigh|max|fast)$/, '');
}

/**
 * سعر النموذج، أو null حين لا سعر رسمي معروف — والـnull يُعرَض «غير متاح»
 * لا يُعامَل صفراً. تلفيق صفر يجعل محادثة كاملة تبدو مجّانية.
 */
/**
 * يُطبّق التغيير المجدول متى حلّ موعده.
 *
 * حدٌّ معلوم: التسعير بأسعار **اليوم** لا بأسعار وقت الاستهلاك — فبعد موعد
 * التغيير تُسعَّر محادثة قديمة بالسعر الجديد. هذا نفس عُرف `PRICES_AS_OF`
 * الذي تعرضه الواجهة، وأثره محصور عملياً: نافذة الاشتراك دورة جارية، ولا
 * يتجاوز الانحراف الدورةَ التي يقع فيها التغيير.
 */
const applySchedule = (price: ModelPrice, today: string): ModelPrice => {
  if (!price.scheduled || today < price.scheduled.effectiveFrom) {
    return price;
  }
  const { effectiveFrom: _effectiveFrom, ...upcoming } = price.scheduled;
  return { ...upcoming, assumed: price.assumed, scheduled: price.scheduled };
};

/** اليوم بصيغة ISO محلية — مُخرَج كي تُثبّته الاختبارات. */
export const todayIso = (now: Date = new Date()): string =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;

export function findModelPrice(model: string, today: string = todayIso()): ModelPrice | null {
  if (!model) {
    return null;
  }

  const direct = MODEL_PRICES[model];
  if (direct) {
    return applySchedule(direct, today);
  }

  const normalized = normalizeModelId(model);
  const normalizedHit = MODEL_PRICES[normalized];
  if (normalizedHit) {
    return applySchedule(normalizedHit, today);
  }

  // مطابقة بالبادئة للمتغيّرات غير المُدرَجة (‏`claude-opus-5-20260301` مثلاً):
  // الأخصّ أولاً حتى لا تبتلع 'gpt-5.1' نسخة 'gpt-5.1-codex-max'.
  //
  // **لكن اللاحقة تُفحَص، ولا تُبتلع أي لاحقة كانت.** كانت المطابقة الساذجة
  // تُسعِّر `deepseek-v4-flash-free` بسعر `deepseek-v4-flash` المدفوع — نموذجٌ
  // اسمه يقول «مجّاني» يُحاسَب بأربع محادثات حقيقية. واللواحق المشروعة صنفٌ
  // مغلق ومعروف (تاريخ إصدار، إقليم، مستوى جهد)، وما عداها متغيّرٌ قد يكون
  // بتسعير مختلف كلّياً ⇒ يُترك بلا سعر ويُعلَن ناقصاً.
  for (const key of PRICE_KEYS_BY_SPECIFICITY) {
    if (!normalized.startsWith(key)) {
      continue;
    }
    const remainder = normalized.slice(key.length);
    if (isKnownVariantSuffix(remainder)) {
      return applySchedule(MODEL_PRICES[key], today);
    }
  }

  return null;
}

/**
 * اللواحق التي لا تغيّر السعر: لا شيء (تطابق تامّ)، أو تاريخ إصدار، أو إقليم،
 * أو مستوى جهد. أي لاحقة أخرى — `-free`، `-beta`، `-thinking`، اسم بوّابة —
 * قد تحمل تسعيراً مغايراً، فالصمت أصدق من إسقاط سعر الأخ الأكبر عليها.
 */
function isKnownVariantSuffix(remainder: string): boolean {
  if (remainder === '') {
    return true;
  }
  return /^-(?:\d{8}|latest|preview|v\d+|(?:us|eu|apac)|(?:low|medium|high|xhigh|max))$/.test(remainder);
}
