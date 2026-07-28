/**
 * الجزء الذي يملكه المالك من حساب الاشتراكات: يوم بداية الدورة، اسم الخطة،
 * وإخفاء مزوّد لا يريده في اللوحة.
 *
 * لماذا الاكتشاف التلقائي أساسٌ والتخزين طبقةٌ فوقه: قائمة الاشتراكات ليست
 * قائمة يكتبها المالك بيده، بل ما هو **مثبَّت ومُصادَق عليه فعلاً** على هذا
 * الجهاز لهذا المستخدم. مزوّد غير مُصادَق ليس اشتراكاً — لا يظهر ولو كان له
 * إعداد مخزَّن (وإعداده يبقى محفوظاً لحظة عودته).
 *
 * التخزين: قيمة JSON واحدة في `app_config` تحت المفتاح `provider_subscriptions`،
 * على سابقة `provider-sharing.js` حرفياً (كاش داخل العملية + تطبيع كل قراءة +
 * تحديث الكاش تزامنياً مع الكتابة). لا جدول جديد لثلاثة حقول لكل مزوّد.
 *
 * ودورة الفوترة تُحسَب هنا لا في طبقة الكلفة: `anchorDay` معناها ملك هذا
 * الملف، ومعها الفخّ الوحيد الحقيقي في الحساب — الشهور القصيرة (يوم 31 في شهر
 * من 30 يوماً، وفبراير 28/29).
 *
 * ومرساة الدورة **تُكتشَف قبل أن تُطلَب من المالك** (‏billing-anchor.service):
 * المخزَّن يعلو حين يضبطه المالك بنفسه، وإلا فالمكتشَف من بيانات الاشتراك، وإلا
 * فالمشتقّ الموسوم «تقدير»، وإلا `unknown` — والفارق بين هذه الأربعة يُحمَل إلى
 * الواجهة في `anchorSource` ولا يُطوى. أوّل الشهر المضروب افتراضاً وهو يدّعي
 * أنه مكتشَف هو الخطأ الذي يحرّمه ADR-078 نصّاً.
 */

import { appConfigDb } from '@/modules/database/index.js';
import {
  billingAnchorService,
  type BillingAnchorProbe,
  type BillingAnchorSource,
} from '@/modules/providers/services/cost/billing-anchor.service.js';
import { providerAuthService } from '@/modules/providers/services/provider-auth.service.js';
import type { LLMProvider } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

/** مفتاح القيمة المخزَّنة في app_config. */
const CONFIG_KEY = 'provider_subscriptions';

/**
 * المزوّدات التي تُقبل مفتاحاً في الإعداد. قائمة ثابتة لا مشتقّة من
 * `providerRegistry`: التحقّق من صحّة مدخل واحد لا يستحق تحميل السجلّ كلّه
 * (وهو يُنشئ كل المزوّدات)، وهي نفس سابقة `KNOWN_PROVIDERS` في
 * provider-sharing.js. ‏`sakana` مستبعَد عمداً — مُعرِّف في نوع الاتحاد بلا
 * تنفيذ خلفه.
 */
export const SUBSCRIPTION_PROVIDERS: readonly string[] = Object.freeze([
  'claude',
  'codex',
  'gemini',
  'cursor',
  'antigravity',
  'opencode',
  'kimi',
  'deepseek',
  'glm',
  'hermes',
]);

/** أسماء العرض — نفس تسميات `MODEL_PROVIDER_LABELS` في routes/commands.js. */
const DISPLAY_NAMES: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude',
  codex: 'Codex',
  gemini: 'Gemini',
  cursor: 'Cursor',
  antigravity: 'Antigravity',
  opencode: 'OpenCode',
  kimi: 'Kimi',
  deepseek: 'DeepSeek',
  glm: 'GLM',
  hermes: 'Hermes',
});

/** أقصى طول لاسم الخطة — حقل حرّ يكتبه المالك، فيُقيَّد كي لا يُخزَّن بلا حدّ. */
const MAX_PLAN_LENGTH = 64;

/** إعدادات مزوّد واحد كما يملكها المالك. */
export type SubscriptionSettings = {
  /**
   * يوم بداية دورة الفوترة (1..31) **كما ضبطه المالك**، و`null` حين لم يضبطه.
   *
   * التمييز جوهري لا تجميلي: القيمة الغائبة كانت تُخزَّن 1، فيستحيل بعدها
   * الفصل بين «المالك اختار أوّل الشهر» و«لم يختر شيئاً فوُضِع 1». وبلا هذا
   * الفصل لا يمكن للاكتشاف أن يعمل بلا أن يدهس اختيار المالك.
   */
  anchorDay: number | null;
  /** اسم الخطة كما يعرفه المالك (Max 20x مثلاً) — لا يُستنتج ولا يُخمَّن. */
  plan: string | null;
  /** مخفيّ من لوحة الاشتراكات (يبقى مُكتشَفاً، ولا يُحسَب). */
  hidden: boolean;
};

/**
 * مزوّد مُكتشَف مع إعداداته **بعد** حسم المرساة. هنا `anchorDay` رقم دائماً
 * (القيمة الفعّالة التي يُحسَب بها)، ومعه `anchorSource` الذي يقول من أين
 * جاءت — فمن يستهلك هذا النوع لا يستطيع عرض الرقم بلا مصدره.
 */
export type SubscriptionEntry = {
  provider: string;
  displayName: string;
  /** القيمة الفعّالة المستعملة في حساب الدورة. */
  anchorDay: number;
  anchorSource: BillingAnchorSource;
  /** مُعرِّف المصدر الحرفي للتدقيق (`null` لليدوي وللمجهول). */
  anchorEvidence: string | null;
  /** طابع الإشارة التي بُني عليها الاكتشاف/الاشتقاق (‏ISO). */
  anchorObservedAt: string | null;
  /** يوم المالك كما هو مخزَّن — `null` يعني «تلقائي». */
  anchorDayOverride: number | null;
  /** اسم الخطة الفعّال: ما كتبه المالك، وإلا ما أعلنه المصدر. */
  plan: string | null;
  /** مصدر اسم الخطة، حتى لا يُعرض المكتشَف كأن المالك كتبه. */
  planSource: 'manual' | 'detected' | 'unknown';
  hidden: boolean;
};

/**
 * ما يُعيده `update`: المخزَّن كما استقرّ، لا الصفّ المحسوم. الكتابة لا تكتشف
 * ولا تلمس القرص — ولو أعادت `SubscriptionEntry` لصارت الكتابة مساراً بطيئاً.
 */
export type StoredSubscriptionView = SubscriptionSettings & {
  provider: string;
  displayName: string;
};

/** رقعة تعديل من واجهة الإعدادات (كل الحقول اختيارية). */
export type SubscriptionPatch = {
  anchorDay?: unknown;
  plan?: unknown;
  hidden?: unknown;
};

/**
 * فحص حالة مزوّد — يُحقن في الاختبار كي لا يُطلق فحص `--version` عملية فرعية.
 * أضيق من `ProviderAuthStatus` عمداً: هذه الحقول الثلاثة وحدها ما يُقرأ هنا.
 */
export type ProviderAuthProbe = (
  provider: string,
  userId?: string | number | null,
) => Promise<{ installed: boolean; authenticated: boolean; method: string | null }>;

/** بذور الحقن للاختبار (وللاستدعاء المتسلسل من طبقة الكلفة). */
export type SubscriptionDeps = {
  probeAuth?: ProviderAuthProbe;
  /** اكتشاف المرساة — يُحقن في الاختبار كي لا يُقرأ قرص الجهاز الحقيقي. */
  discoverAnchor?: BillingAnchorProbe;
};

const DEFAULT_SETTINGS: SubscriptionSettings = Object.freeze({
  anchorDay: null,
  plan: null,
  hidden: false,
});

/**
 * المرساة حين لا مصدر ولا اشتقاق: الشهر الميلادي. تُحمَل بـ`unknown` لا
 * بـ`detected` — الرقم نفسه، والادّعاء مختلف تماماً.
 */
const FALLBACK_ANCHOR_DAY = 1;

/** اسم العرض لمزوّد غير مذكور في الخريطة: مُعرِّفه بحرف أول كبير. */
const displayNameFor = (provider: string): string =>
  DISPLAY_NAMES[provider] ?? (provider ? provider[0].toUpperCase() + provider.slice(1) : provider);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** يقرأ إعدادات مزوّد واحد من قيمة مخزَّنة قد تكون تالفة أو ناقصة. */
function normalizeSettings(raw: unknown): SubscriptionSettings {
  if (!isRecord(raw)) {
    return { ...DEFAULT_SETTINGS };
  }

  const anchorDay = Number(raw.anchorDay);
  const plan = typeof raw.plan === 'string' && raw.plan.trim() ? raw.plan.trim() : null;

  return {
    // قيمة خارج المدى (أو غائبة) ⇒ «لم يضبطها المالك» ⇒ يعمل الاكتشاف.
    anchorDay: Number.isInteger(anchorDay) && anchorDay >= 1 && anchorDay <= 31 ? anchorDay : null,
    plan,
    hidden: raw.hidden === true,
  };
}

/**
 * كاش داخل العملية (null قبل أول قراءة). قيمة واحدة صغيرة تُقرأ في كل عرض
 * للوحة الكلفة، فلا داعي لضرب SQLite في كل مرّة — والكتابة تُحدّثه تزامنياً
 * فيسري التغيير على الطلب التالي مباشرة.
 */
let cache: Record<string, SubscriptionSettings> | null = null;

function loadCache(): Record<string, SubscriptionSettings> {
  if (cache !== null) {
    return cache;
  }

  const result: Record<string, SubscriptionSettings> = {};
  try {
    const stored = appConfigDb.get(CONFIG_KEY);
    const parsed: unknown = stored ? JSON.parse(stored) : null;
    if (isRecord(parsed)) {
      for (const provider of SUBSCRIPTION_PROVIDERS) {
        if (parsed[provider] !== undefined) {
          result[provider] = normalizeSettings(parsed[provider]);
        }
      }
    }
  } catch (error) {
    // قيمة تالفة لا تُسقط اللوحة: يُعاد إلى الافتراضات ويُسجَّل السبب.
    console.error('[subscription-config] failed to load config, using defaults', {
      error: error instanceof Error ? error.message : String(error),
    });
  }

  cache = result;
  return cache;
}

/**
 * كاش قصير العمر لنتيجة فحص المصادقة. الفحص يُطلق `<cli> --version` عبر
 * spawnSync لكل مزوّد (‏isCliInstalled)، وقائمة الاشتراكات تفحص عشرة مزوّدات
 * دفعةً — أي عشر عمليات فرعية في كل استعلام لوحة. النافذة قصيرة عمداً: مزوّد
 * سُجِّل دخوله للتوّ يظهر خلال دقيقة على أبعد تقدير.
 */
const AUTH_CACHE_TTL_MS = 60_000;
const authCache = new Map<string, { at: number; status: { installed: boolean; authenticated: boolean; method: string | null } }>();

const defaultProbe: ProviderAuthProbe = async (provider, userId) =>
  providerAuthService.getProviderAuthStatus(provider, userId ?? null);

/** مزوّد لم يُقطَع بحاله — لا يُدّعى اشتراكاً. */
const UNKNOWN_AUTH = Object.freeze({ installed: false, authenticated: false, method: null });

/**
 * حالة مزوّد لمستخدم بعينه. الكاش يُتخطّى كلّياً حين يُحقن فحص مخصَّص: اختبارٌ
 * يعدّ الاستدعاءات لا يجوز أن يقرأ بقايا اختبار قبله.
 *
 * وفشل الفحص — أياً كان مصدره — ليس «غير مُصادَق» يقيناً، لكنه لا يبرّر ادّعاء
 * اشتراك قائم؛ ولا يُخزَّن في الكاش كي يُعاد المحاولة فوراً.
 */
export async function probeProviderAuth(
  provider: string,
  userId?: string | number | null,
  deps: SubscriptionDeps = {},
): Promise<{ installed: boolean; authenticated: boolean; method: string | null }> {
  if (deps.probeAuth) {
    try {
      const status = await deps.probeAuth(provider, userId ?? null);
      return {
        installed: status.installed === true,
        authenticated: status.authenticated === true,
        method: status.method ?? null,
      };
    } catch {
      return { ...UNKNOWN_AUTH };
    }
  }

  const key = `${provider}|${userId ?? ''}`;
  const cached = authCache.get(key);
  if (cached && Date.now() - cached.at < AUTH_CACHE_TTL_MS) {
    return cached.status;
  }

  try {
    const status = await defaultProbe(provider, userId ?? null);
    const value = {
      installed: status.installed === true,
      authenticated: status.authenticated === true,
      method: status.method ?? null,
    };
    authCache.set(key, { at: Date.now(), status: value });
    return value;
  } catch {
    return { ...UNKNOWN_AUTH };
  }
}

/**
 * كاش قصير لاكتشاف المرساة، بنفس منطق كاش المصادقة: الاكتشاف يلمس القرص لكل
 * مزوّد في كل عرض للوحة. (‏billing-anchor له كاشه الداخلي أيضاً؛ هذا يقيه
 * الاستدعاء أصلاً حين تُسأل اللوحة مرّتين في ثانية.)
 */
const ANCHOR_CACHE_TTL_MS = 60_000;
const anchorCache = new Map<string, { at: number; value: Awaited<ReturnType<BillingAnchorProbe>> }>();

/**
 * يحسم المرساة لمزوّد واحد: المخزَّن (يدوي) ⇒ المكتشَف ⇒ المشتقّ ⇒ المجهول.
 *
 * المخزَّن أوّلاً بلا استدعاء اكتشاف أصلاً: من ضبط يومه بيده لا يُقرأ قرصه بلا
 * داع، ولا يُنقَض اختياره باكتشاف أحدث.
 */
async function resolveAnchor(
  provider: string,
  userId: string | number | null,
  settings: SubscriptionSettings,
  deps: SubscriptionDeps,
): Promise<{
  anchorDay: number;
  anchorSource: BillingAnchorSource;
  anchorEvidence: string | null;
  anchorObservedAt: string | null;
  detectedPlan: string | null;
}> {
  if (settings.anchorDay !== null) {
    return {
      anchorDay: settings.anchorDay,
      anchorSource: 'manual',
      anchorEvidence: null,
      anchorObservedAt: null,
      detectedPlan: null,
    };
  }

  let discovery: Awaited<ReturnType<BillingAnchorProbe>> = null;
  if (deps.discoverAnchor) {
    try {
      discovery = await deps.discoverAnchor(provider, userId ?? null);
    } catch {
      discovery = null;
    }
  } else {
    const key = `${provider}|${userId ?? ''}`;
    const cached = anchorCache.get(key);
    if (cached && Date.now() - cached.at < ANCHOR_CACHE_TTL_MS) {
      discovery = cached.value;
    } else {
      discovery = await billingAnchorService.discover(provider, userId ?? null);
      anchorCache.set(key, { at: Date.now(), value: discovery });
    }
  }

  if (!discovery) {
    return {
      anchorDay: FALLBACK_ANCHOR_DAY,
      anchorSource: 'unknown',
      anchorEvidence: null,
      anchorObservedAt: null,
      detectedPlan: null,
    };
  }

  return {
    anchorDay: discovery.anchorDay,
    anchorSource: discovery.source,
    anchorEvidence: discovery.evidence,
    anchorObservedAt: discovery.observedAt,
    detectedPlan: discovery.plan,
  };
}

// ---------------------------------------------------------------------------
// دورة الفوترة
// ---------------------------------------------------------------------------

export type BillingCycle = { start: Date; end: Date };

/** عدد أيام شهر بعينه (اليوم الصفري من الشهر التالي = آخر أيام هذا الشهر). */
const daysInMonth = (year: number, month: number): number => new Date(year, month + 1, 0).getDate();

/**
 * الدورة الجارية `[start, end)` من يوم البداية.
 *
 * الفخّ: يوم 31 لا وجود له في نصف شهور السنة، ولا يوم 30 في فبراير. القاعدة
 * المعتمدة (وهي ما تفعله بوّابات الاشتراك عملياً): **يُقصَّ إلى آخر يوم في
 * الشهر**، ولا يُزحف إلى الشهر التالي — الزحف يُنتج دورة بلا بداية في فبراير
 * ويُسقط أيامه من كل حساب.
 *
 * الحدود بالتوقيت المحلّي للخادم لا UTC: المالك يقرأ «دورتي تبدأ يوم 9» بساعته،
 * ومنتصف ليل محلّي هو ما يعنيه. الترشيح داخل المُستخرِج يقارن epoch ms فيبقى
 * التحويل صحيحاً مهما كانت المنطقة.
 */
export function resolveBillingCycle(anchorDay: number, now: Date = new Date()): BillingCycle {
  const anchor = Number.isInteger(anchorDay) ? Math.min(31, Math.max(1, anchorDay)) : 1;

  const year = now.getFullYear();
  const month = now.getMonth();
  const anchorThisMonth = Math.min(anchor, daysInMonth(year, month));

  // قبل يوم البداية ⇒ نحن في دورة بدأت الشهر الماضي.
  const startsThisMonth = now.getDate() >= anchorThisMonth;
  const startYear = startsThisMonth ? year : month === 0 ? year - 1 : year;
  const startMonth = startsThisMonth ? month : month === 0 ? 11 : month - 1;

  const start = new Date(startYear, startMonth, Math.min(anchor, daysInMonth(startYear, startMonth)), 0, 0, 0, 0);

  const endYear = startMonth === 11 ? startYear + 1 : startYear;
  const endMonth = startMonth === 11 ? 0 : startMonth + 1;
  const end = new Date(endYear, endMonth, Math.min(anchor, daysInMonth(endYear, endMonth)), 0, 0, 0, 0);

  return { start, end };
}

// ---------------------------------------------------------------------------
// الخدمة
// ---------------------------------------------------------------------------

export const subscriptionConfigService = {
  /** الإعدادات المخزَّنة كما هي (بلا اكتشاف) — للتشخيص وللكتابة فوقها. */
  getStored(): Record<string, SubscriptionSettings> {
    const stored = loadCache();
    return Object.fromEntries(Object.entries(stored).map(([provider, settings]) => [provider, { ...settings }]));
  },

  /** إعدادات مزوّد واحد (المخزَّن فوق الافتراضي). لا يفحص المصادقة. */
  getSettings(provider: string): SubscriptionSettings {
    return { ...(loadCache()[provider] ?? DEFAULT_SETTINGS) };
  },

  /**
   * المزوّدات المُكتشَفة لهذا المستخدم مع إعداداتها. الاكتشاف = مثبَّت **و**
   * مُصادَق عليه في بيئة هذا المستخدم بعينه (‏resolveProviderEnv داخل كل
   * مزوّد)، فالمستخدم المعزول يُقاس على اعتماده هو لا على اعتماد المشغّل.
   *
   * المخفيّ يظهر في القائمة موسوماً `hidden` — واجهة الإعدادات تحتاج رؤيته
   * لتُتيح إعادة إظهاره؛ حساب الكلفة هو الذي يستبعده (`listActive`).
   */
  async list(userId?: string | number | null, deps: SubscriptionDeps = {}): Promise<SubscriptionEntry[]> {
    const stored = loadCache();
    const entries: SubscriptionEntry[] = [];

    for (const provider of SUBSCRIPTION_PROVIDERS) {
      const status = await probeProviderAuth(provider, userId, deps);
      if (!status.installed || !status.authenticated) {
        continue;
      }

      const settings = stored[provider] ?? DEFAULT_SETTINGS;
      const anchor = await resolveAnchor(provider, userId ?? null, settings, deps);

      entries.push({
        provider,
        displayName: displayNameFor(provider),
        anchorDay: anchor.anchorDay,
        anchorSource: anchor.anchorSource,
        anchorEvidence: anchor.anchorEvidence,
        anchorObservedAt: anchor.anchorObservedAt,
        anchorDayOverride: settings.anchorDay,
        plan: settings.plan ?? anchor.detectedPlan,
        planSource: settings.plan ? 'manual' : anchor.detectedPlan ? 'detected' : 'unknown',
        hidden: settings.hidden,
      });
    }

    return entries;
  },

  /** المُكتشَف غير المخفيّ — ما تُحسَب كلفته فعلاً. */
  async listActive(userId?: string | number | null, deps: SubscriptionDeps = {}): Promise<SubscriptionEntry[]> {
    const entries = await this.list(userId, deps);
    return entries.filter((entry) => !entry.hidden);
  },

  /**
   * يكتب رقعة تعديل لمزوّد واحد. التحقّق يرفض ما لا يُخزَّن أصلاً بدل أن
   * يُطبّعه صامتاً: قيمة `anchorDay` خاطئة تُغيّر كل مبالغ الدورة، فالصمت عنها
   * أسوأ من الرفض.
   */
  update(provider: string, patch: SubscriptionPatch = {}): StoredSubscriptionView {
    if (!SUBSCRIPTION_PROVIDERS.includes(provider)) {
      throw new AppError(`Unknown subscription provider "${provider}".`, {
        code: 'UNKNOWN_SUBSCRIPTION_PROVIDER',
        statusCode: 400,
      });
    }

    const current = loadCache()[provider] ?? DEFAULT_SETTINGS;
    const next: SubscriptionSettings = { ...current };

    if (patch.anchorDay !== undefined) {
      // `null` صراحةً = «أعِدها تلقائية»، وهو الطريق الوحيد للتراجع عن ضبط
      // يدوي؛ بدونه يبقى أوّل رقم كتبه المالك حاجباً للاكتشاف إلى الأبد.
      if (patch.anchorDay === null) {
        next.anchorDay = null;
      } else {
        const anchorDay = typeof patch.anchorDay === 'number' ? patch.anchorDay : Number.NaN;
        if (!Number.isInteger(anchorDay) || anchorDay < 1 || anchorDay > 31) {
          throw new AppError('anchorDay must be an integer between 1 and 31, or null for auto-detect.', {
            code: 'INVALID_ANCHOR_DAY',
            statusCode: 400,
          });
        }
        next.anchorDay = anchorDay;
      }
    }

    if (patch.plan !== undefined) {
      if (patch.plan === null) {
        next.plan = null;
      } else if (typeof patch.plan === 'string' && patch.plan.trim().length <= MAX_PLAN_LENGTH) {
        next.plan = patch.plan.trim() || null;
      } else {
        throw new AppError(`plan must be a string of at most ${MAX_PLAN_LENGTH} characters, or null.`, {
          code: 'INVALID_SUBSCRIPTION_PLAN',
          statusCode: 400,
        });
      }
    }

    if (patch.hidden !== undefined) {
      if (typeof patch.hidden !== 'boolean') {
        throw new AppError('hidden must be a boolean.', {
          code: 'INVALID_SUBSCRIPTION_HIDDEN',
          statusCode: 400,
        });
      }
      next.hidden = patch.hidden;
    }

    // قراءة-دمج-كتابة على القيمة كاملةً: مفتاح app_config واحد لكل المزوّدات،
    // فكتابة مزوّد لا يجوز أن تمحو جيرانه.
    const merged = { ...loadCache(), [provider]: next };
    appConfigDb.set(CONFIG_KEY, JSON.stringify(merged));
    cache = merged;
    // إعادة اليوم إلى «تلقائي» تستدعي اكتشافاً جديداً في الطلب التالي.
    for (const key of [...anchorCache.keys()]) {
      if (key.startsWith(`${provider}|`)) {
        anchorCache.delete(key);
      }
    }

    return { provider, displayName: displayNameFor(provider), ...next };
  },

  /** خطّاف اختبار: يُسقط الكاشات فتُقرأ الحالة من جديد. ليس على مسار الطلب. */
  _resetCaches(): void {
    cache = null;
    authCache.clear();
    anchorCache.clear();
    billingAnchorService._resetCache();
  },
};

/** يُصدَّر للاختبار وللتحقّق من مُعرِّف مزوّد قبل استدعاء الخدمة. */
export const isKnownSubscriptionProvider = (provider: string): provider is LLMProvider =>
  SUBSCRIPTION_PROVIDERS.includes(provider);
