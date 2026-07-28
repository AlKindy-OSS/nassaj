/**
 * اكتشاف مرساة دورة الفوترة من بيانات الاشتراك نفسها بدل أن يكتبها المالك بيده.
 *
 * ما أثبته الفحص على هذا الجهاز (‏2026-07-28) — لا افتراضاً:
 *
 * 1. **كودكس/ChatGPT يعلن دورته صراحةً.** ‏`~/.codex/auth.json` يحمل `id_token`
 *    وفي حمولته مجال `https://api.openai.com/auth` بمفاتيح
 *    `chatgpt_subscription_active_start` و`chatgpt_subscription_active_until`
 *    و`chatgpt_plan_type`. مقيس على اعتماد حيّ: بداية 2026-07-11 ونهاية
 *    2026-08-11 — دورة شهرية كاملة معلَنة، أي مرساة **حقيقية** لا مشتقّة.
 *
 * 2. **كلود يخزّن تاريخ إنشاء الاشتراك محلّياً.** واجهة الاستخدام
 *    (`/api/oauth/usage`) لا تحمل مرساة (‏ADR-078 §2.6، وهو صحيح)، لكن
 *    `/api/oauth/profile` يُعيد `organization.subscription_created_at`،
 *    و**العميل يكتب هذه الاستجابة على القرص** في `.claude.json` تحت
 *    `oauthAccount.subscriptionCreatedAt` (ومعها `profileFetchedAt`). فُحصت
 *    على اعتمادَي المشغّل والمستخدم المعزول: موجودة في الاثنين.
 *    ولذلك **لا نداء شبكياً هنا ولا قارئ اعتمادات ثانياً**: الملف المحلّي يحمل
 *    نفس الحقل الذي كنّا سنطلبه، بلا توكن أصلاً.
 *
 * 3. **ما لا مصدر له لا يُدّعى.** بقيّة المزوّدات لا تكشف تاريخ فوترة في أي
 *    ملف أو نقطة نهاية وصلنا إليها. البديل الوحيد الأمين اشتقاق **معلَن أنه
 *    اشتقاق**: يوم الشهر لأقدم استهلاك مسجَّل لهذا المزوّد على هذا الجهاز.
 *    وهو تقدير — قد يكون تاريخ أول تشغيل لا تاريخ أول فاتورة — فيخرج
 *    بـ`source: 'derived'` ويظهر في الواجهة موسوماً «تقدير»، ويبقى المالك
 *    قادراً على تجاوزه. عرضه كأنه حقيقة هو بالضبط ما يحرّمه ADR-078.
 *
 * العزل (‏ADR-014): كل المسارات تُشتقّ من `resolveProviderEnv` للمستخدم الطالب،
 * فالمستخدم المعزول يُقرأ اشتراكه هو. ولا يُصعَد إلى بيت المشغّل احتياطياً —
 * مرساة المشغّل ليست مرساة المستخدم، وقراءتها تسريب وخطأ معاً.
 *
 * الأمن: لا يُقرأ من `auth.json` إلا حمولة الـJWT (‏base64 مكشوفة أصلاً)، ولا
 * يُسجَّل ولا يُعاد أي توكن. فكّ الترميز بلا تحقّق توقيع مقصود: القيمة هنا
 * **تلميح عرض** لا قرار صلاحية، ومصدرها قرص المستخدم نفسه.
 */

import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type { BillingAnchorSource } from '@/shared/types.js';
import { readObjectRecord, readOptionalString } from '@/shared/utils.js';

/**
 * مصدر المرساة معرَّف في عقد `@/shared/types` لا هنا: العميل يعرضه، فهو جزء من
 * العقد لا تفصيل داخلي. يُعاد تصديره لمن يستورد هذه الخدمة وحدها.
 *
 *  • `manual`   — ضبطها المالك بنفسه، فتعلو على كل اكتشاف.
 *  • `detected` — حقل حقيقي من بيانات الاشتراك (كودكس: دورة معلَنة، كلود:
 *                 تاريخ إنشاء الاشتراك).
 *  • `derived`  — **تقدير** مشتقّ من أقدم استهلاك مرصود، يُعرض موسوماً.
 *  • `unknown`  — لا مصدر ولا اشتقاق؛ يُفترض الشهر الميلادي ويُقال ذلك صراحةً.
 */
export type { BillingAnchorSource };

/** نتيجة اكتشاف واحدة. `null` تعني: لم نجد شيئاً — ولا نخترع. */
export type BillingAnchorDiscovery = {
  /** يوم الشهر (1..31) الذي تبدأ عنده الدورة. */
  anchorDay: number;
  source: 'detected' | 'derived';
  /** مُعرِّف المصدر الحرفي للتدقيق، لا نصّ عرض. */
  evidence: string;
  /** طابع الإشارة التي اشتُقّ منها اليوم (‏ISO)، ليقرأ المالك على ماذا بُني. */
  observedAt: string | null;
  /** نهاية الدورة كما يعلنها المصدر — كودكس وحده يعلنها اليوم. */
  periodEnd: string | null;
  /** اسم الخطة كما يعلنه المصدر. لا يُخمَّن؛ `null` حين لا يعلنه. */
  plan: string | null;
};

/** بذور الحقن: تجعل الاختبار يعمل على قرص مؤقّت بلا بيئة حقيقية. */
export type BillingAnchorDeps = {
  /** بديل `resolveProviderEnv` (نفس التوقيع، الحقلان المستعملان فقط). */
  resolveEnv?: (
    userId: string | number | null,
    provider: string,
    baseEnv?: NodeJS.ProcessEnv,
  ) => NodeJS.ProcessEnv;
  /** بيئة الأساس — تُمرَّر كما هي إلى `resolveEnv`. */
  env?: NodeJS.ProcessEnv;
  /** تجاوز جذر السجلّات للاشتقاق (اختبار). */
  historyRoot?: (provider: string, userId: string | number | null) => string | null;
};

/** سقف المسح عند الاشتقاق: أقدم ملف يُعثر عليه ضمن هذا السقف لا مسح مفتوح. */
const MAX_SCANNED_ENTRIES = 4000;

/** عمق التفريع في جذر السجلّات (كودكس ينظّم `sessions/YYYY/MM/DD/`). */
const MAX_SCAN_DEPTH = 6;

/**
 * كاش قصير: الاكتشاف يلمس القرص، ولوحة الاشتراكات تسأل عن عشرة مزوّدات في كل
 * عرض. النافذة قصيرة كي يظهر تجديد اشتراك أو تسجيل دخول جديد خلال دقائق.
 */
const DISCOVERY_TTL_MS = 600_000;

type CacheEntry = { at: number; value: BillingAnchorDiscovery | null };

const discoveryCache = new Map<string, CacheEntry>();

const isValidDay = (value: number): boolean => Number.isInteger(value) && value >= 1 && value <= 31;

/**
 * يوم الشهر من طابع ISO **بالتوقيت المحلّي للخادم** — لأن `resolveBillingCycle`
 * يبني حدوده بمنتصف ليل محلّي؛ خلط UTC هنا يزحف بالمرساة يوماً كاملاً في نصف
 * مناطق العالم.
 */
function anchorDayFromIso(iso: string | null): { day: number; iso: string } | null {
  if (!iso) {
    return null;
  }
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) {
    return null;
  }
  return { day: date.getDate(), iso: date.toISOString() };
}

async function readJsonFile(filePath: string): Promise<Record<string, unknown> | null> {
  try {
    return readObjectRecord(JSON.parse(await readFile(filePath, 'utf8')));
  } catch {
    // ملف غائب أو تالف ليس خطأً هنا: يعني «لا مصدر»، وهو جواب مقبول.
    return null;
  }
}

/**
 * ‏`resolveProviderEnv` مكتوب بـJSDoc ويُضيّق المزوّد إلى اتحاد أسمائه؛ وهنا
 * المزوّد نصّ عام (‏SUBSCRIPTION_PROVIDERS)، فيُعبَر بالتوقيع الموسَّع في موضع
 * واحد بدل نثر `as` في كل نداء. المزوّد المجهول يُعيد بيئةً بلا مفاتيح عزل،
 * وهو ما نريده تماماً: لا جذر ⇒ لا اكتشاف.
 */
type ProviderEnvResolver = (
  userId: string | number | null,
  provider: string,
  baseEnv?: NodeJS.ProcessEnv,
) => NodeJS.ProcessEnv;

function providerEnv(
  provider: string,
  userId: string | number | null,
  deps: BillingAnchorDeps,
): NodeJS.ProcessEnv {
  const resolve = deps.resolveEnv ?? (resolveProviderEnv as ProviderEnvResolver);
  try {
    return resolve(userId, provider, deps.env ?? process.env) ?? {};
  } catch {
    return {};
  }
}

/** جذر إعداد كلود لهذا المستخدم (‏CLAUDE_CONFIG_DIR أو `~/.claude`). */
function claudeConfigDir(userId: string | number | null, deps: BillingAnchorDeps): string {
  const env = providerEnv('claude', userId, deps);
  return readOptionalString(env.CLAUDE_CONFIG_DIR) ?? path.join(os.homedir(), '.claude');
}

/** جذر كودكس لهذا المستخدم (‏CODEX_HOME أو `~/.codex`). */
function codexHome(userId: string | number | null, deps: BillingAnchorDeps): string {
  const env = providerEnv('codex', userId, deps);
  return readOptionalString(env.CODEX_HOME) ?? path.join(os.homedir(), '.codex');
}

// ---------------------------------------------------------------------------
// كلود
// ---------------------------------------------------------------------------

/**
 * اسم الخطة من نوع المنظّمة/طبقة الحدّ. مطابق قصداً لـ`derivePlanName` في
 * `claude-usage.service.ts` (خاصّة هناك، فلا تُستورَد): جدول واحد صغير في
 * موضعين خير من تصدير داخليّات خدمة أخرى لأجل سطرين.
 */
function claudePlanFromTier(tier: string | null, organizationType: string | null): string | null {
  const normalized = (tier ?? '').toLowerCase();
  if (normalized.includes('max_20x') || normalized.includes('max20x')) {
    return 'Max 20x';
  }
  if (normalized.includes('max_5x') || normalized.includes('max5x')) {
    return 'Max 5x';
  }
  if (normalized.includes('pro')) {
    return 'Pro';
  }

  const type = (organizationType ?? '').toLowerCase();
  if (type === 'claude_max') {
    return 'Max';
  }
  if (type === 'claude_pro') {
    return 'Pro';
  }
  return null;
}

/**
 * مرساة كلود من `.claude.json`.
 *
 * موضع الملف: العميل يكتبه **داخل** `CLAUDE_CONFIG_DIR` حين يكون مضبوطاً
 * (مفحوص على مستخدم معزول)، وفي البيت مباشرةً حين لا يكون (‏`~/.claude.json`
 * بجوار `~/.claude`). فيُجرَّب الموضعان بهذا الترتيب — وكلاهما داخل جذر
 * المستخدم نفسه، فلا صعود إلى بيت المشغّل.
 */
async function detectClaudeAnchor(
  userId: string | number | null,
  deps: BillingAnchorDeps,
): Promise<BillingAnchorDiscovery | null> {
  const configDir = claudeConfigDir(userId, deps);
  const candidates = [path.join(configDir, '.claude.json'), path.join(path.dirname(configDir), '.claude.json')];

  for (const candidate of candidates) {
    const root = await readJsonFile(candidate);
    const account = readObjectRecord(root?.oauthAccount);
    if (!account) {
      continue;
    }

    const anchor = anchorDayFromIso(readOptionalString(account.subscriptionCreatedAt) ?? null);
    if (!anchor || !isValidDay(anchor.day)) {
      // حساب بلا اشتراك (مجاني أو انقطع): لا يوم فوترة يُدّعى.
      continue;
    }

    return {
      anchorDay: anchor.day,
      source: 'detected',
      evidence: '.claude.json#oauthAccount.subscriptionCreatedAt',
      observedAt: anchor.iso,
      periodEnd: null,
      plan: claudePlanFromTier(
        readOptionalString(account.organizationRateLimitTier) ?? null,
        readOptionalString(account.organizationType) ?? null,
      ),
    };
  }

  return null;
}

// ---------------------------------------------------------------------------
// كودكس
// ---------------------------------------------------------------------------

/** مجال دعاوى OpenAI داخل الـ‏id_token. */
const OPENAI_AUTH_CLAIM = 'https://api.openai.com/auth';

/**
 * حمولة الـJWT فقط (المقطع الأوسط). لا تحقّق توقيع ولا استعمال للتوكن نفسه —
 * انظر ملاحظة الأمن أعلى الملف.
 */
function decodeJwtClaims(token: string): Record<string, unknown> | null {
  const segment = token.split('.')[1];
  if (!segment) {
    return null;
  }
  try {
    return readObjectRecord(JSON.parse(Buffer.from(segment, 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

/** اسم الخطة من `chatgpt_plan_type` كما تُكتب في واجهات OpenAI. */
function codexPlanLabel(planType: string | null): string | null {
  if (!planType) {
    return null;
  }
  const normalized = planType.toLowerCase();
  if (normalized === 'plus') return 'Plus';
  if (normalized === 'pro') return 'Pro';
  if (normalized === 'team') return 'Team';
  if (normalized === 'business') return 'Business';
  if (normalized === 'enterprise') return 'Enterprise';
  if (normalized === 'free') return null; // مجاني ليس اشتراكاً بدورة.
  return planType.charAt(0).toUpperCase() + planType.slice(1);
}

/**
 * مرساة كودكس من دعاوى `id_token` في `auth.json`.
 *
 * الدورة معلَنة بطرفيها، فتُؤخذ البداية مرساةً وتُحمل النهاية كما هي. والطابع
 * قد يكون قديماً (‏id_token لا يُجدَّد مع كل نبضة) — واليوم من الشهر لا يتغيّر
 * بتقادمه، وهو كل ما نحتاجه؛ ويبقى `observedAt` معروضاً كي يرى المالق قِدَم
 * الإشارة بنفسه.
 */
async function detectCodexAnchor(
  userId: string | number | null,
  deps: BillingAnchorDeps,
): Promise<BillingAnchorDiscovery | null> {
  const root = await readJsonFile(path.join(codexHome(userId, deps), 'auth.json'));
  const tokens = readObjectRecord(root?.tokens);
  const idToken = readOptionalString(tokens?.id_token);
  if (!idToken) {
    return null;
  }

  const claims = decodeJwtClaims(idToken);
  const auth = readObjectRecord(claims?.[OPENAI_AUTH_CLAIM]);
  if (!auth) {
    return null;
  }

  const anchor = anchorDayFromIso(readOptionalString(auth.chatgpt_subscription_active_start) ?? null);
  if (!anchor || !isValidDay(anchor.day)) {
    return null;
  }

  const until = anchorDayFromIso(readOptionalString(auth.chatgpt_subscription_active_until) ?? null);

  return {
    anchorDay: anchor.day,
    source: 'detected',
    evidence: 'codex/auth.json#id_token.chatgpt_subscription_active_start',
    observedAt: anchor.iso,
    periodEnd: until?.iso ?? null,
    plan: codexPlanLabel(readOptionalString(auth.chatgpt_plan_type) ?? null),
  };
}

// ---------------------------------------------------------------------------
// الاشتقاق (حين لا مصدر)
// ---------------------------------------------------------------------------

/**
 * جذر سجلّات المزوّد لهذا المستخدم. المزوّد غير المذكور لا جذر له، فلا اشتقاق
 * له أصلاً — وهذا أصدق من مسح عشوائي.
 */
function historyRootFor(
  provider: string,
  userId: string | number | null,
  deps: BillingAnchorDeps,
): string | null {
  if (deps.historyRoot) {
    return deps.historyRoot(provider, userId);
  }
  if (provider === 'claude') {
    return path.join(claudeConfigDir(userId, deps), 'projects');
  }
  if (provider === 'codex') {
    return path.join(codexHome(userId, deps), 'sessions');
  }
  return null;
}

/**
 * أقدم زمن تعديل ضمن شجرة، بسقف عدد ومستوى. الترتيب أبجدي مقصود: جذور
 * السجلّات مؤرشفة بالتاريخ (`YYYY/MM/DD`)، فالأبجدي يزور الأقدم أوّلاً ويجعل
 * السقف يقطع الأحدث لا الأقدم.
 */
async function oldestMtime(root: string, depth = 0, budget = { remaining: MAX_SCANNED_ENTRIES }): Promise<number | null> {
  if (depth > MAX_SCAN_DEPTH || budget.remaining <= 0) {
    return null;
  }

  let entries: Dirent<string>[];
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }

  let oldest: number | null = null;
  for (const entry of [...entries].sort((a, b) => a.name.localeCompare(b.name))) {
    if (budget.remaining <= 0) {
      break;
    }
    budget.remaining -= 1;
    const full = path.join(root, entry.name);

    if (entry.isDirectory()) {
      const nested = await oldestMtime(full, depth + 1, budget);
      if (nested !== null && (oldest === null || nested < oldest)) {
        oldest = nested;
      }
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    try {
      const info = await stat(full);
      if (oldest === null || info.mtimeMs < oldest) {
        oldest = info.mtimeMs;
      }
    } catch {
      // ملف اختفى بين القراءة والفحص: يُتجاوز.
    }
  }

  return oldest;
}

/**
 * اشتقاق المرساة من أقدم استهلاك مرصود. **تقدير معلَن**: هو يوم أول أثر باقٍ
 * لهذا المزوّد على هذا الجهاز، وقد يسبق الاشتراك أو يليه (سجلّ محذوف، جهاز
 * جديد). يُعاد بـ`source: 'derived'` ليصل إلى الواجهة موسوماً، لا مختلطاً
 * بالمكتشَف.
 */
async function deriveAnchorFromHistory(
  provider: string,
  userId: string | number | null,
  deps: BillingAnchorDeps,
): Promise<BillingAnchorDiscovery | null> {
  const root = historyRootFor(provider, userId, deps);
  if (!root) {
    return null;
  }

  const oldest = await oldestMtime(root);
  if (oldest === null) {
    return null;
  }

  const date = new Date(oldest);
  if (Number.isNaN(date.getTime()) || !isValidDay(date.getDate())) {
    return null;
  }

  return {
    anchorDay: date.getDate(),
    source: 'derived',
    evidence: 'oldest-recorded-usage',
    observedAt: date.toISOString(),
    periodEnd: null,
    plan: null,
  };
}

// ---------------------------------------------------------------------------
// الواجهة
// ---------------------------------------------------------------------------

export const billingAnchorService = {
  /**
   * يكتشف مرساة مزوّد واحد: الحقل الحقيقي أوّلاً، ثم الاشتقاق المعلَن، ثم
   * `null` — و`null` جوابٌ صحيح لا فشل: معناه «لا نعرف»، وهو ما تقوله الطبقة
   * الأعلى للمالك بدل أن تفترض أوّل الشهر.
   */
  async discover(
    provider: string,
    userId: string | number | null = null,
    deps: BillingAnchorDeps = {},
  ): Promise<BillingAnchorDiscovery | null> {
    const injected = deps.resolveEnv || deps.env || deps.historyRoot;
    const key = `${provider}|${userId ?? ''}`;

    if (!injected) {
      const cached = discoveryCache.get(key);
      if (cached && Date.now() - cached.at < DISCOVERY_TTL_MS) {
        return cached.value;
      }
    }

    let value: BillingAnchorDiscovery | null = null;
    try {
      if (provider === 'claude') {
        value = await detectClaudeAnchor(userId, deps);
      } else if (provider === 'codex') {
        value = await detectCodexAnchor(userId, deps);
      }

      if (!value) {
        value = await deriveAnchorFromHistory(provider, userId, deps);
      }
    } catch {
      // اكتشاف فاشل لا يُسقط اللوحة، ولا يُخزَّن كي يُعاد فوراً.
      return null;
    }

    if (!injected) {
      discoveryCache.set(key, { at: Date.now(), value });
    }
    return value;
  },

  /** خطّاف اختبار: يُفرِغ كاش الاكتشاف. ليس على مسار الطلب. */
  _resetCache(): void {
    discoveryCache.clear();
  },
};

/** نوع الفحص المحقون في طبقة الإعداد (وفي الاختبار). */
export type BillingAnchorProbe = (
  provider: string,
  userId: string | number | null,
) => Promise<BillingAnchorDiscovery | null>;
