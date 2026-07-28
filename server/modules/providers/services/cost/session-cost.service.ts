/**
 * طبقة الخدمة للكلفة: تصل بين سجلّات القرص (المُستخرِجات) وجدول الأسعار من جهة،
 * وبين المسارات/الواجهة من جهة أخرى. لا تحسب توكناً ولا سعراً بنفسها.
 *
 * ثلاثة قرارات تحكم هذا الملف كلّه:
 *
 *  • **الصمت أصدق من رقم مُلفَّق.** مزوّد لا يحفظ استهلاكه على القرص لا يُقدَّر
 *    ولا يُصفَّر: يعود `available:false` مع سبب مكتوب. صفرٌ يُعرض كأنه قياس
 *    أسوأ من فراغ يُعرض كفراغ، لأن الأول يُصدَّق.
 *
 *  • **`metered` ليس تفصيلاً تجميلياً.** اشتراك (Claude Max / ChatGPT) لا
 *    يُحاسَب بالتوكن، فما نحسبه له هو **القيمة المكافئة لسعر الـAPI** لا مالٌ
 *    دُفع. يُقرأ من طريقة المصادقة الفعلية (مفتاح API ⇒ مقيس)، وعند أي شكّ
 *    يبقى `false` — ادّعاء «فاتورة» على اشتراك أسوأ الخطأين.
 *
 *  • **لا تُقرأ محادثة مرّتين بلا سبب.** الكاش مفتاحه (المسار + بصمة التعديل +
 *    النافذة)، فملف لم يتغيّر لا يُقرأ ثانية، وملف نما يسقط مفتاحه تلقائياً.
 *    ومسح الدورة الشهرية يتخطّى — بـstat وحده — كل ملف لم يُكتب فيه شيء منذ
 *    بداية الدورة، فلا يُفتح أصلاً.
 */

import { readdir, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import { participantsDb, sessionsDb } from '@/modules/database/index.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import type { BillingAnchorSource } from '@/shared/types.js';
import { readOptionalString } from '@/shared/utils.js';

import { breakdownFromSessionCosts, type ModelBreakdownRow } from './cost-breakdown.js';
import { calculateSessionCost, sumSessionCosts, type SessionCost } from './cost-calculator.js';
import {
  collectHermesCycleUsage,
  collectOpenCodeCycleUsage,
  databaseSignature,
  extractOpenCodeSessionUsage,
  resolveHermesCostDatabasePath,
  resolveOpenCodeCostDatabasePath,
  HERMES_SESSION_UNLINKABLE_REASON,
  type DbCycleUsageOutcome,
} from './db-usage-extractors.js';
import {
  harnessVendor,
  resolveModelVendor,
  vendorDisplayName,
  type VendorKey,
} from './model-vendor.js';
import { PRICES_AS_OF } from './model-pricing.js';
import {
  probeProviderAuth,
  resolveBillingCycle,
  subscriptionConfigService,
  type BillingCycle,
  type SubscriptionDeps,
} from './subscription-config.service.js';
import {
  extractClaudeSessionUsage,
  extractCodexSessionUsage,
  type TokenTotals,
  type UsageWindow,
} from './usage-extractors.js';

// ---------------------------------------------------------------------------
// أنواع العقد (نفس شكل الاستجابة حرفياً — المسارات تمرّرها كما هي)
// ---------------------------------------------------------------------------

export type SessionModelCostView = {
  model: string;
  /** null = لا سعر رسمي لهذا النموذج (لا «صفر»). */
  costUsd: number | null;
  requests: number;
  tokens: TokenTotals;
};

export type SessionCostView = {
  sessionId: string;
  provider: string;
  /** false ⇒ لا قياس ممكن لهذا المزوّد/المحادثة، والسبب في `reason`. */
  available: boolean;
  reason?: string;
  /** true = مالٌ يُحاسَب بالتوكن فعلاً؛ false = قيمة مكافئة لسعر الـAPI. */
  metered: boolean;
  totalUsd: number;
  complete: boolean;
  unpricedModels: string[];
  subagentRequests: number;
  pricesAsOf: string;
  perModel: SessionModelCostView[];
};

export type SubscriptionCostView = {
  provider: string;
  displayName: string;
  plan: string | null;
  anchorDay: number;
  /** بداية الدورة الجارية (ISO). */
  cycleStart: string;
  /** نهايتها حصراً — `[cycleStart, cycleEnd)`. */
  cycleEnd: string;
  available: boolean;
  reason?: string;
  metered: boolean;
  totalUsd: number;
  /** عدد المحادثات التي ساهمت فعلاً داخل الدورة. */
  sessions: number;
  complete: boolean;
  unpricedModels: string[];
  /** نماذج بسعر مفترَض لا رسمي — تُسمّى في الواجهة كتقدير. */
  assumedModels?: string[];
  /** من أين جاء `anchorDay` — يُعرض بجانبه في الواجهة. */
  anchorSource: BillingAnchorSource;
  anchorEvidence: string | null;
  anchorObservedAt: string | null;
  /**
   * تفصيل الدورة: الأجسام التي مرّ منها استهلاك هذا المورّد، وداخل كل جسم
   * نماذجه. غيابه (undefined) يعني «لا تفصيل متاح» لا «لم يُستهلك شيء».
   */
  byHarness?: HarnessCostView[];
};

/** صفّ نموذج داخل جسم واحد، مجموعاً عبر محادثات الدورة. */
export type HarnessModelCostView = {
  model: string;
  /** null = لا سعر رسمي (لا «صفر»). */
  costUsd: number | null;
  requests: number;
  sessions: number;
};

/** جسمٌ مرّ منه استهلاك هذا المورّد. */
export type HarnessCostView = {
  harness: string;
  displayName: string;
  totalUsd: number;
  sessions: number;
  perModel: HarnessModelCostView[];
};

/** بذور الحقن للاختبار: ساعة ثابتة وفحص مصادقة بلا عملية فرعية. */
export type SessionCostDeps = SubscriptionDeps & {
  now?: () => Date;
};

// ---------------------------------------------------------------------------
// ما يُقاس وما لا يُقاس — حقائق مُتحقَّقة على هذا الجهاز (2026-07-28)
// ---------------------------------------------------------------------------

/**
 * مزوّدات تحفظ استهلاكها في **قاعدة SQLite** لا في ملف JSONL، فمسارها مختلف
 * من أوّله: لا `jsonl_path` (وهو `null` في صفوفها فعلاً) ولا بصمة ملف سجلّ —
 * القاعدة نفسها هي المصدر والبصمة.
 */
const DB_BACKED_PROVIDERS = new Set(['opencode', 'hermes']);

/** المزوّدات التي لها مُستخرِج فعلي يقرأ استهلاكاً من القرص. */
const MEASURABLE_PROVIDERS = new Set(['claude', 'codex', ...DB_BACKED_PROVIDERS]);

/**
 * سبب غياب القياس لكل مزوّد — نصّ قصير صادق لا اعتذار عام. الفروق حقيقية:
 * أنتيغرافيتي لا يكتب عدّاداً أصلاً، وكرسر لا يُظهره في سجلّه، وبقيتها تبثّه
 * لحظياً لكن نسّاج لا يحفظ مجموعاً لكل محادثة بعد — الأخير نقصٌ عندنا لا عندهم،
 * ويُقال كذلك.
 *
 * سقط من هذه القائمة `opencode` و`hermes`: صارا يُقاسان من قاعدتيهما
 * (‏`db-usage-extractors`)، وإبقاء سببٍ يقول «لا يُحفظ» بعد أن صار يُحفظ كذبٌ
 * في الاتجاه المعاكس.
 */
const UNMEASURABLE_REASONS: Readonly<Record<string, string>> = Object.freeze({
  antigravity: 'Antigravity (agy) records no token counts in its transcripts, so cost cannot be measured.',
  agy: 'Antigravity (agy) records no token counts in its transcripts, so cost cannot be measured.',
  cursor: 'Cursor does not expose token usage in its CLI transcripts.',
  gemini: 'Gemini reports usage per turn, but nassaj does not persist a per-conversation total yet.',
  kimi: 'Kimi reports usage per turn, but nassaj does not persist a per-conversation total yet.',
  glm: 'GLM reports usage per turn, but nassaj does not persist a per-conversation total yet.',
  deepseek: 'DeepSeek reports usage per turn, but nassaj does not persist a per-conversation total yet.',
});

const unmeasurableReason = (provider: string): string =>
  UNMEASURABLE_REASONS[provider] ?? `Cost measurement is not implemented for "${provider}".`;

// ---------------------------------------------------------------------------
// الكاش
// ---------------------------------------------------------------------------

/**
 * سقف الكاش. كل مُدخَل كلفة محادثة واحدة (سطر لكل نموذج، وأربعة نماذج سقفٌ
 * عملي) أي مئات البايتات — ‏512 مُدخَلاً أقل من ميغابايت، وهو أكبر من عدد
 * المحادثات الحيّة في أي دورة على هذا التثبيت. الإخراج **بالأقدم استعمالاً**:
 * الـMap يحفظ ترتيب الإدراج، فكل قراءة ناجحة تُعيد إدراج مفتاحها في الذيل،
 * والفائض يُحذف من الرأس. مُدخَل ملفٍّ تغيّر لا يُبطَل صراحةً — مفتاحه يحمل
 * بصمة التعديل فلا يُطابَق أبداً بعد التغيير، ويسقط بالإخراج وحده.
 */
const MAX_CACHE_ENTRIES = 512;
const costCache = new Map<string, SessionCost>();

function cacheGet(key: string): SessionCost | undefined {
  const cached = costCache.get(key);
  if (cached) {
    costCache.delete(key);
    costCache.set(key, cached);
  }
  return cached;
}

function cacheSet(key: string, value: SessionCost): void {
  costCache.set(key, value);
  while (costCache.size > MAX_CACHE_ENTRIES) {
    const oldest = costCache.keys().next();
    if (oldest.done) {
      break;
    }
    costCache.delete(oldest.value);
  }
}

const windowKey = (window?: UsageWindow): string =>
  window && (window.since !== undefined || window.until !== undefined)
    ? `${window.since ?? ''}:${window.until ?? ''}`
    : 'all';

// ---------------------------------------------------------------------------
// بصمة الملف
// ---------------------------------------------------------------------------

type TranscriptSignature = {
  /** آخر تعديل معروف (ملف الأمّ وما تحته) — يقرّر الإبطال والتخطّي معاً. */
  newestMs: number;
  /** مجموع الأحجام. **ليس زينةً**: طوابع الوقت خشنة الدقّة (مقيس على /tmp
   *  هنا: تتقدّم كل 4ms)، فتعديلان في نفس النبضة يحملان mtime واحداً — والحجم
   *  هو ما يفرّقهما. يبقى حدّ معروف: تغيير لا يمسّ الحجم داخل نفس النبضة
   *  يُخدَم من الكاش، وهو ما يقبله أي كاش مبنيّ على (زمن، حجم). */
  size: number;
};

/** يمشي المجلّد تنازلياً: أحدث تعديل ومجموع الأحجام. للمسار المفرد وحده. */
async function scanSubagentTree(directory: string): Promise<{ newestMs: number; totalSize: number }> {
  let newestMs = 0;
  let totalSize = 0;

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // لا مجلّد وكلاء فرعيين لهذه المحادثة.
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      try {
        const entryStat = await stat(full);
        newestMs = Math.max(newestMs, entryStat.mtimeMs);
        totalSize += entryStat.size;
      } catch {
        // مُدخَل اختفى أثناء المشي — يُتجاهل.
      }
    }
  };

  await walk(directory);
  return { newestMs, totalSize };
}

/**
 * بصمة محادثة. `deep` للمحادثة المفردة: يمشي مجلّد الوكلاء الفرعيين فيُبطِل
 * الكاش لحظة كتابة أي وكيل. المسح الشهري يستعمل الضحلة (‏stat على الملف
 * والمجلّد) لأن مشي آلاف المجلّدات في كل عرض لوحة لا يُحتمَل — وهو كافٍ هناك:
 * قرار التخطّي يقارن بحدّ الدورة (أسابيع) لا بثوانٍ، وسطر نتيجة الوكيل يُكتب
 * في ملف الأمّ عند انتهائه فيتحرّك mtime على أي حال.
 */
async function transcriptSignature(
  provider: string,
  transcriptPath: string,
  options: { deep?: boolean } = {},
): Promise<TranscriptSignature | null> {
  let fileStat;
  try {
    fileStat = await stat(transcriptPath);
  } catch {
    return null;
  }
  if (!fileStat.isFile()) {
    return null;
  }

  let newestMs = fileStat.mtimeMs;
  let size = fileStat.size;

  if (provider === 'claude') {
    const subagentDirectory = transcriptPath.replace(/\.jsonl$/, '');
    if (options.deep) {
      const tree = await scanSubagentTree(subagentDirectory);
      newestMs = Math.max(newestMs, tree.newestMs);
      size += tree.totalSize;
    } else {
      try {
        const directoryStat = await stat(subagentDirectory);
        if (directoryStat.isDirectory()) {
          newestMs = Math.max(newestMs, directoryStat.mtimeMs);
        }
      } catch {
        // لا وكلاء فرعيين — البصمة هي ملف الأمّ وحده.
      }
    }
  }

  return { newestMs, size };
}

// ---------------------------------------------------------------------------
// مسار السجلّ
// ---------------------------------------------------------------------------

type SessionRow = {
  session_id: string;
  provider: string;
  project_path: string | null;
  jsonl_path: string | null;
};

/**
 * جذور مشاريع كلود المحتملة لهذا المستخدم. مسار السجلّ المخزَّن هو الطريق
 * الأول دائماً؛ هذه للاحتياط حين يغيب (صفّ قديم أو مؤقّت). محادثات كلود
 * **مشتركة** بالتصميم (‏provisionUserDirs يربط projects/ رمزياً إلى جذر
 * المشغّل)، فالجذران يلتقيان عملياً — يُجرَّبان معاً لأن السياسة قابلة للتغيير.
 */
function claudeProjectRoots(userId: string | number | null): string[] {
  const roots = new Set<string>();
  try {
    const env = resolveProviderEnv(userId, 'claude', process.env);
    const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR);
    if (configDir) {
      roots.add(path.join(configDir, 'projects'));
    }
  } catch {
    // فشل حلّ البيئة لا يمنع الاحتياط الأخير أدناه.
  }
  roots.add(path.join(os.homedir(), '.claude', 'projects'));
  return [...roots];
}

const fileExists = async (candidate: string): Promise<boolean> => {
  try {
    return (await stat(candidate)).isFile();
  } catch {
    return false;
  }
};

/**
 * يحلّ مسار سجلّ المحادثة. `jsonl_path` في جدول الجلسات هو مفتاح الوصل وهو
 * مطلق ومحلول أصلاً (يكتبه المُزامِن)، فيُستعمل كما هو متى وُجد الملف.
 *
 * الاحتياط لكلود وحده: ‏`<projects>/<مسار-المشروع-مُرمَّزاً>/<sessionId>.jsonl`
 * — الترميز نفسه المستعمل في بقيّة الخادم (كل ما ليس حرفاً أو رقماً أو شرطة
 * يصير شرطة). كودكس لا احتياط له: اسم ملف الـrollout يحمل طابعاً زمنياً لا
 * يُشتقّ من الصفّ، والبحث عنه يعني مشي شجرة التواريخ كلّها.
 */
async function resolveTranscriptPath(row: SessionRow, userId: string | number | null): Promise<string | null> {
  const stored = (row.jsonl_path ?? '').trim();
  if (stored && (await fileExists(stored))) {
    return stored;
  }

  if (row.provider !== 'claude' || !row.project_path) {
    return null;
  }

  const encoded = row.project_path.replace(/[^a-zA-Z0-9-]/g, '-');
  for (const root of claudeProjectRoots(userId)) {
    const candidate = path.join(root, encoded, `${row.session_id}.jsonl`);
    if (await fileExists(candidate)) {
      return candidate;
    }
  }

  return null;
}

// ---------------------------------------------------------------------------
// القياس
// ---------------------------------------------------------------------------

/** يقرأ كلفة سجلّ واحد عبر الكاش. المفتاح يحمل البصمة فلا يُخدم رقم قديم. */
async function costForTranscript(
  provider: string,
  transcriptPath: string,
  signature: TranscriptSignature,
  window?: UsageWindow,
): Promise<SessionCost> {
  const key = `${provider}|${transcriptPath}|${signature.newestMs}|${signature.size}|${windowKey(window)}`;
  const cached = cacheGet(key);
  if (cached) {
    return cached;
  }

  const usage =
    provider === 'codex'
      ? await extractCodexSessionUsage(transcriptPath, window)
      : await extractClaudeSessionUsage(transcriptPath, window);

  const cost = calculateSessionCost(usage);
  cacheSet(key, cost);
  return cost;
}

/**
 * مسار القواعد (opencode / hermes) بموازاة `costForTranscript`: نفس الكاش
 * ونفس قاعدة الإبطال، والبصمة هنا بصمة ملف القاعدة ومعه `-wal` — إذ يكتب
 * opencode في WAL دقائق قبل أن يمسّ القاعدة نفسها، فبصمة الملف وحده تُجمّد
 * الرقم على قيمة قديمة.
 */
async function costForDbSession(
  provider: string,
  databasePath: string,
  sessionId: string,
  window?: UsageWindow,
): Promise<SessionCost | { unavailable: string }> {
  const signature = await databaseSignature(databasePath);
  if (!signature) {
    return { unavailable: `The ${provider} usage database is not on disk, so cost cannot be measured.` };
  }

  const key = `${provider}|db|${databasePath}|${sessionId}|${signature.newestMs}|${signature.size}|${windowKey(window)}`;
  const cached = cacheGet(key);
  if (cached) {
    return cached;
  }

  const outcome = extractOpenCodeSessionUsage(databasePath, sessionId, window);
  if (!outcome.available) {
    return { unavailable: outcome.reason };
  }

  const cost = calculateSessionCost(outcome.usage);
  cacheSet(key, cost);
  return cost;
}

/** نسخة خارجية من الكلفة المخبَّأة — لا يُسلَّم مرجع داخلي قابل للتعديل. */
const toSessionCostView = (
  sessionId: string,
  provider: string,
  cost: SessionCost,
  metered: boolean,
): SessionCostView => ({
  sessionId,
  provider,
  available: true,
  metered,
  totalUsd: cost.totalUsd,
  complete: cost.complete,
  unpricedModels: [...cost.unpricedModels],
  subagentRequests: cost.subagentRequests,
  pricesAsOf: cost.pricesAsOf,
  perModel: cost.perModel.map((entry) => ({
    model: entry.model,
    costUsd: entry.costUsd,
    requests: entry.requests,
    tokens: { ...entry.tokens },
  })),
});

const unavailableSessionCost = (sessionId: string, provider: string, reason: string): SessionCostView => ({
  sessionId,
  provider,
  available: false,
  reason,
  metered: false,
  totalUsd: 0,
  complete: false,
  unpricedModels: [],
  subagentRequests: 0,
  pricesAsOf: PRICES_AS_OF,
  perModel: [],
});

/**
 * هل يُحاسَب هذا المزوّد بالتوكن فعلاً لهذا المستخدم؟ الإشارة الوحيدة الصادقة
 * هي طريقة المصادقة القائمة: مفتاح API ⇒ مال مقيس؛ ‏OAuth/ملف اعتماد ⇒ اشتراك.
 * وهي تصف **الحاضر** لا لحظة تشغيل المحادثة — من بدّل اشتراكه بمفتاح تتبدّل
 * صفة محادثاته القديمة، وهذا مقبول لأن البديل تخمين تاريخ لا سجلّ له.
 */
async function isMetered(
  provider: string,
  userId: string | number | null,
  deps: SessionCostDeps,
): Promise<boolean> {
  try {
    const status = await probeProviderAuth(provider, userId, deps);
    return status.authenticated && status.method === 'api_key';
  } catch {
    return false;
  }
}

/**
 * نطاق المحادثات المنسوبة لمستخدم في اشتراك مزوّد.
 *
 * مزوّد **معزول** يعني أن لكل مستخدم اعتماده واشتراكه، فما يُحسب له محادثاته
 * هو (‏participants أو كاتب رسالة). مزوّد **مشترك** يعني اشتراكاً واحداً
 * للجميع، فالمجموع كل محادثات المزوّد — وتقسيمه على المستخدمين يُنقص المجموع
 * الوحيد الذي له معنى.
 *
 * حدّ معروف: النسبة على مستوى المحادثة لا الطلب. محادثة كتب فيها اثنان تُحسب
 * لكليهما كاملةً — البديل نسبة كل طلب إلى اعتماد بعينه، وهي غير مسجَّلة أصلاً.
 */
function sessionScope(provider: string, userId: string | number | null): Set<string> | null {
  if (!isProviderIsolated(provider)) {
    return null;
  }
  const numericId = typeof userId === 'number' ? userId : Number(userId);
  if (!Number.isInteger(numericId)) {
    return new Set<string>();
  }
  return new Set(participantsDb.getSessionIdsForUser(numericId));
}

type ProviderCycleTotals = {
  totalUsd: number;
  sessions: number;
  complete: boolean;
  unpricedModels: string[];
  /** تفصيل نموذج-نموذج حين أمكن بناؤه؛ غيابه = لا تفصيل، لا «صفر». */
  perModel?: ModelBreakdownRow[];
};

/**
 * مجموع كلفة مزوّد داخل دورة.
 *
 * أسوأ حالة: صفّ واحد من قاعدة البيانات لكل محادثات المزوّد، ثم `stat` أو
 * اثنان لكل محادثة (الملف ومجلّد وكلائه)، ثم **قراءة كاملة للملفات المكتوب
 * فيها داخل الدورة وحدها وغير المخبَّأة**. أي أن كلفة الاستدعاء المتكرّر
 * تساوي عدد المحادثات × stat — والقراءة تقع مرّة واحدة لكل تغيّر فعلي. ملف لم
 * يُلمس منذ بداية الدورة لا يُفتح إطلاقاً: لا سطر فيه يمكن أن يحمل طابعاً داخل
 * النافذة.
 *
 * مقيس على نسخة من قاعدة الإنتاج (2026-07-28، دورة يوليو): ‏141 محادثة كلود +
 * 54 كودكس = ‏5.6 ثانية أول استدعاء بعد الإقلاع، ثم **7 ملّي ثانية** لكل
 * استدعاء تالٍ ما لم تتغيّر الملفات. الثقل كلّه في القراءة الأولى، ولا مفرّ
 * منها: معرفة ما كُتب داخل النافذة تستلزم فتح ما كُتب فيه.
 *
 * وسجلّ محذوف (كنس الاحتفاظ ~30 يوماً لدى كلود) يُنقص المجموع بلا أثر ظاهر،
 * فيُرفَع `complete=false` — «جزئي» أصدق من مجموع يبدو نهائياً وهو ناقص.
 */
/**
 * مجموع دورة مزوّد يقرأ من قاعدة SQLite.
 *
 * النطاق هنا **هو مسار القاعدة نفسه** لا ترشيح المشاركين: المزوّد المعزول
 * تُحلّ له قاعدة تحت جذر مستخدمه فلا يرى غيرها، والمشترك يقرأ الجميع من قاعدة
 * المشغّل الواحدة — وهو المعنى نفسه الذي يصنعه `sessionScope` في مسار الملفات.
 *
 * ‏Hermes مشترك اليوم باعتماد واحد (‏`~/.hermes/auth.json`)، فمجموعه مجموع
 * الجهاز لا مجموع مستخدم — وهذا هو الرقم الوحيد ذو المعنى ما دام الاشتراك
 * واحداً.
 */
async function sumDbProviderCycle(
  provider: string,
  userId: string | number | null,
  cycle: BillingCycle,
): Promise<ProviderCycleTotals> {
  const window: UsageWindow = { since: cycle.start.getTime(), until: cycle.end.getTime() };
  const databasePath =
    provider === 'opencode' ? resolveOpenCodeCostDatabasePath(userId) : resolveHermesCostDatabasePath(userId);

  const outcome: DbCycleUsageOutcome =
    provider === 'opencode'
      ? collectOpenCodeCycleUsage(databasePath, window)
      : collectHermesCycleUsage(databasePath, window);

  if (!outcome.available) {
    // قاعدة غائبة ليست «صفر إنفاق»: تُعرض جزئيةً بلا محادثات، والسبب يظهر في
    // مسار المحادثة المفردة. رفعُ `complete` هنا يجعل صفراً يبدو مؤكَّداً.
    return { totalUsd: 0, sessions: 0, complete: false, unpricedModels: [] };
  }

  const summed = sumSessionCosts(outcome.sessions.map((usage) => calculateSessionCost(usage)));
  return {
    totalUsd: summed.totalUsd,
    sessions: summed.sessions,
    complete: summed.complete,
    unpricedModels: summed.unpricedModels,
  };
}

/**
 * كلفة محادثات جسم واحد داخل الدورة، محادثةً محادثة (بلا جمع ولا نسبة إلى
 * مورّد). الفصل مقصود: نفس محادثات الجسم قد تُغذّي أكثر من اشتراك — محادثة
 * opencode واحدة تحمل نماذج GLM ونماذج بوّابة OpenCode معاً — فالجمع يقع بعد
 * التصنيف لا قبله.
 */
type HarnessCycleCosts = {
  costs: SessionCost[];
  /** false حين سقط شيء من الحساب (سجلّ مفقود أو قاعدة غائبة). */
  complete: boolean;
};

async function collectHarnessCycleCosts(
  harness: string,
  userId: string | number | null,
  cycle: BillingCycle,
): Promise<HarnessCycleCosts> {
  if (!MEASURABLE_PROVIDERS.has(harness)) {
    return { costs: [], complete: true };
  }

  const window: UsageWindow = { since: cycle.start.getTime(), until: cycle.end.getTime() };

  if (DB_BACKED_PROVIDERS.has(harness)) {
    const databasePath =
      harness === 'opencode' ? resolveOpenCodeCostDatabasePath(userId) : resolveHermesCostDatabasePath(userId);
    const outcome: DbCycleUsageOutcome =
      harness === 'opencode'
        ? collectOpenCodeCycleUsage(databasePath, window)
        : collectHermesCycleUsage(databasePath, window);

    if (!outcome.available) {
      // قاعدة غائبة ليست «صفر إنفاق» — تُعلَن نقصاً.
      return { costs: [], complete: false };
    }
    return { costs: outcome.sessions.map((usage) => calculateSessionCost(usage)), complete: true };
  }

  const cycleStartMs = cycle.start.getTime();
  const scope = sessionScope(harness, userId);
  const costs: SessionCost[] = [];
  let missingTranscripts = 0;

  for (const row of sessionsDb.getSessionFilePathsByProvider(harness)) {
    if (scope && !scope.has(row.session_id)) {
      continue;
    }

    const signature = await transcriptSignature(harness, row.jsonl_path);
    if (!signature) {
      missingTranscripts += 1;
      continue;
    }
    if (signature.newestMs < cycleStartMs) {
      continue;
    }

    const cost = await costForTranscript(harness, row.jsonl_path, signature, window);
    if (cost.perModel.length === 0) {
      continue;
    }
    costs.push(cost);
  }

  return { costs, complete: missingTranscripts === 0 };
}

/**
 * **كل** جسم قابل للقياس يُمسح لكل مورّد.
 *
 * كان هذا المسح مقصوراً على الحوامل المعلَنة (‏opencode) وعلى الجسم صاحب
 * المورّد — وهو خطأ مُثبَت بالقياس: ‏GLM يعمل أيضاً **تحت جسم claude** عبر
 * توجيه `ANTHROPIC_BASE_URL`، فستّ محادثات claude في الدورة الجارية تحمل صفوف
 * `glm-5.2`/`glm-4.7` بقيمة ‏$0.998. القصر كان يُسقطها من بطاقة GLM (فتقلّ
 * ‏3.4×) ومن بطاقة Claude معاً (لأن مورّدها ليس anthropic) — مالٌ يقع بين
 * البطاقتين، وبطاقةُ Claude تقول «مكتمل».
 *
 * المسح الشامل ليس أغلى: التجميع محفوظ لكل (جسم، نافذة)، وعدد النوافذ
 * المتمايزة = عدد أيام المرساة المختلفة (اثنان أو ثلاثة عملياً).
 */
const measurableHarnesses = (): string[] => [...MEASURABLE_PROVIDERS];

type HarnessCollectionMemo = Map<string, Promise<HarnessCycleCosts>>;

const collectHarnessCycleCostsMemo = (
  memo: HarnessCollectionMemo,
  harness: string,
  userId: string | number | null,
  cycle: BillingCycle,
): Promise<HarnessCycleCosts> => {
  const key = `${harness}|${cycle.start.getTime()}|${cycle.end.getTime()}`;
  const cached = memo.get(key);
  if (cached) {
    return cached;
  }
  const pending = collectHarnessCycleCosts(harness, userId, cycle);
  memo.set(key, pending);
  return pending;
};

type VendorCycleTotals = {
  totalUsd: number;
  sessions: number;
  complete: boolean;
  unpricedModels: string[];
  /** نماذج داخل هذا المورّد سُعِّرت بسعر مفترَض لا رسمي. */
  assumedModels: string[];
  byHarness: HarnessCostView[];
};

/**
 * مجموع مورّد داخل دورته = مجموع صفوف نماذجه **أينما شُغِّلت**.
 *
 * جوهر التصحيح: الاشتراك يُشترى من المورّد، فلا يُحسب بجسمٍ واحد ولا يُنسب
 * إلى الحامل. والمجموع يُبنى من نفس الصفوف المعروضة، فمجموع البطاقة = مجموع
 * أجسامها = مجموع نماذجها بنيوياً.
 */
async function sumVendorCycle(
  vendor: VendorKey,
  userId: string | number | null,
  cycle: BillingCycle,
  memo: HarnessCollectionMemo,
): Promise<VendorCycleTotals> {
  const byHarness: HarnessCostView[] = [];
  const unpriced = new Set<string>();
  const assumed = new Set<string>();
  let totalUsd = 0;
  let sessions = 0;
  let complete = true;

  for (const harness of measurableHarnesses()) {
    const collected = await collectHarnessCycleCostsMemo(memo, harness, userId, cycle);

    const models = new Map<string, { costUsd: number | null; requests: number; sessions: number }>();
    let harnessTotal = 0;
    let harnessSessions = 0;
    let contributedHere = false;

    for (const cost of collected.costs) {
      let sessionContributed = false;

      for (const row of cost.perModel) {
        if (resolveModelVendor(row.model, harness) !== vendor) {
          continue;
        }
        sessionContributed = true;

        const current = models.get(row.model) ?? { costUsd: null, requests: 0, sessions: 0 };
        if (row.costUsd === null) {
          // نقصُ هذا المورّد من صفوفه هو وحده — لا من صفوف جاره في نفس
          // المحادثة. قبل هذا كانت بطاقة GLM تُوسَم «جزئية» لأن نموذج
          // opencode-zen في المحادثة نفسها بلا سعر، بلا سطر يفسّر الوسم.
          unpriced.add(row.model);
          complete = false;
        } else {
          current.costUsd = (current.costUsd ?? 0) + row.costUsd;
          harnessTotal += row.costUsd;
          // سعرٌ مفترَض داخل صفوف هذا المورّد ⇒ بطاقته تقديرية لا مؤكَّدة.
          if (cost.assumedModels?.includes(row.model)) {
            assumed.add(row.model);
            complete = false;
          }
        }
        current.requests += row.requests;
        current.sessions += 1;
        models.set(row.model, current);
      }

      if (sessionContributed) {
        harnessSessions += 1;
        contributedHere = true;
      }
    }

    // سجلٌّ مفقود يُنقص التغطية حين يخصّ هذا المورّد فعلاً: جسمٌ أسهم فيه،
    // أو الجسم الذي هذا المورّد مورّدُه الطبيعي.
    if (!collected.complete && (contributedHere || harnessVendor(harness) === vendor)) {
      complete = false;
    }

    if (!contributedHere) {
      continue;
    }

    totalUsd += harnessTotal;
    sessions += harnessSessions;
    byHarness.push({
      harness,
      displayName: harnessDisplayName(harness),
      totalUsd: harnessTotal,
      sessions: harnessSessions,
      perModel: [...models.entries()]
        .map(([model, row]) => ({ model, ...row }))
        .sort((a, b) => (b.costUsd ?? -1) - (a.costUsd ?? -1)),
    });
  }

  return {
    totalUsd,
    sessions,
    complete,
    unpricedModels: [...unpriced],
    assumedModels: [...assumed],
    byHarness: byHarness.sort((a, b) => b.totalUsd - a.totalUsd),
  };
}

/** اسم الجسم كما يُعرض. الأجسام قليلة ومعروفة، فالجدول أوضح من اشتقاق. */
const HARNESS_LABELS: Readonly<Record<string, string>> = Object.freeze({
  claude: 'Claude Code',
  codex: 'Codex',
  opencode: 'OpenCode',
  glm: 'GLM CLI',
  kimi: 'Kimi CLI',
  hermes: 'Hermes',
  antigravity: 'Antigravity',
  gemini: 'Gemini CLI',
});

const harnessDisplayName = (harness: string): string => HARNESS_LABELS[harness] ?? harness;

async function sumProviderCycle(
  provider: string,
  userId: string | number | null,
  cycle: BillingCycle,
): Promise<ProviderCycleTotals> {
  if (DB_BACKED_PROVIDERS.has(provider)) {
    return sumDbProviderCycle(provider, userId, cycle);
  }

  const cycleStartMs = cycle.start.getTime();
  const window: UsageWindow = { since: cycleStartMs, until: cycle.end.getTime() };
  const scope = sessionScope(provider, userId);
  const contributing: SessionCost[] = [];
  let missingTranscripts = 0;

  for (const row of sessionsDb.getSessionFilePathsByProvider(provider)) {
    if (scope && !scope.has(row.session_id)) {
      continue;
    }

    const signature = await transcriptSignature(provider, row.jsonl_path);
    if (!signature) {
      missingTranscripts += 1;
      continue;
    }
    if (signature.newestMs < cycleStartMs) {
      continue;
    }

    const cost = await costForTranscript(provider, row.jsonl_path, signature, window);
    // محادثة بلا مساهمة داخل النافذة ليست «محادثة هذه الدورة» ولا تُعدّ.
    if (cost.perModel.length === 0) {
      continue;
    }
    contributing.push(cost);
  }

  // التفصيل يُبنى من نفس المحادثات المساهِمة، فمجموع صفوفه هو الإجمالي نفسه
  // بنيوياً لا مصادفةً — رقمان محسوبان بطريقين يفترقان حتماً.
  const breakdown = breakdownFromSessionCosts(provider, contributing);
  return {
    totalUsd: breakdown.totalUsd,
    sessions: breakdown.sessions,
    complete: breakdown.complete && missingTranscripts === 0,
    unpricedModels: breakdown.unpricedModels,
    perModel: breakdown.perModel,
  };
}

// ---------------------------------------------------------------------------
// الخدمة
// ---------------------------------------------------------------------------

export const sessionCostService = {
  /**
   * كلفة محادثة واحدة. لا تتحقّق من صلاحية الاطّلاع — ذلك على المسار الذي
   * يستدعيها (نفس حرس الملكية المطبَّق على قراءة المحادثة نفسها).
   *
   * محادثة غير مفهرسة أو بلا سجلّ على القرص تعود `available:false` بسبب مكتوب
   * لا استثناءً: نافذة الكلفة جزء من شاشة المحادثة، ولا يجوز أن تُسقطها.
   */
  async getSessionCost(
    sessionId: string,
    userId: string | number | null = null,
    deps: SessionCostDeps = {},
  ): Promise<SessionCostView> {
    const row = sessionsDb.getSessionById(sessionId);
    if (!row) {
      return unavailableSessionCost(sessionId, '', 'This conversation is not indexed, so its cost cannot be measured.');
    }

    const provider = row.provider;
    if (!MEASURABLE_PROVIDERS.has(provider)) {
      return unavailableSessionCost(sessionId, provider, unmeasurableReason(provider));
    }

    // مزوّدات القواعد أوّلاً: صفوفها بلا `jsonl_path` أصلاً، فتمريرها على
    // حلّال المسار يعيدها «لا سجلّ على القرص» وهو سببٌ خاطئ لغيابٍ سببه آخر.
    if (DB_BACKED_PROVIDERS.has(provider)) {
      if (provider === 'hermes') {
        return unavailableSessionCost(sessionId, provider, HERMES_SESSION_UNLINKABLE_REASON);
      }

      const dbCost = await costForDbSession(provider, resolveOpenCodeCostDatabasePath(userId), sessionId);
      if ('unavailable' in dbCost) {
        return unavailableSessionCost(sessionId, provider, dbCost.unavailable);
      }
      if (dbCost.perModel.length === 0) {
        return unavailableSessionCost(
          sessionId,
          provider,
          'This conversation records no token usage, so its cost cannot be measured.',
        );
      }

      return toSessionCostView(sessionId, provider, dbCost, await isMetered(provider, userId, deps));
    }

    const transcriptPath = await resolveTranscriptPath(row, userId);
    if (!transcriptPath) {
      return unavailableSessionCost(sessionId, provider, 'The transcript file for this conversation is no longer on disk.');
    }

    const signature = await transcriptSignature(provider, transcriptPath, { deep: true });
    if (!signature) {
      return unavailableSessionCost(sessionId, provider, 'The transcript file for this conversation is no longer on disk.');
    }

    const cost = await costForTranscript(provider, transcriptPath, signature);

    // استخراج فارغ ليس «لم يُنفَق شيء». `complete` تعني «لا نموذج بلا سعر ولا
    // بند بلا سعر»، وكلاهما يتحقّق بداهةً حين لا استهلاك أصلاً — فيمرّ السجلّ
    // الخالي من عدّادات (‏rollout بلا token_count، أو محادثة سُجّلت جزئياً)
    // كأنه محادثة مجّانية مؤكَّدة، ويطبع 0.00$. هذا بالضبط الرقم المُلفَّق
    // الذي يمنعه ADR-078: الغياب يُعلَن غياباً.
    if (cost.perModel.length === 0) {
      return unavailableSessionCost(
        sessionId,
        provider,
        'This conversation records no token usage, so its cost cannot be measured.',
      );
    }

    const metered = await isMetered(provider, userId, deps);
    return toSessionCostView(sessionId, provider, cost, metered);
  },

  /**
   * كلفة الدورة الجارية لكل اشتراك نشط. النافذة الزمنية هي سبب وجود وسيط
   * `window` في المُستخرِجات: محادثة واحدة تمتدّ دورتين، ونسبتها كاملةً إلى
   * دورة بدايتها تُفسد الشهرين معاً.
   */
  async getSubscriptionCosts(
    userId: string | number | null = null,
    deps: SessionCostDeps = {},
  ): Promise<SubscriptionCostView[]> {
    const now = deps.now?.() ?? new Date();
    const active = await subscriptionConfigService.listActive(userId, deps);
    // تجميعٌ واحد لكل (جسم، نافذة) يخدم كل المورّدين — المسح الشامل بلا تكرار.
    const collectionMemo: HarnessCollectionMemo = new Map();

    // البطاقة اشتراكٌ يُدفع، أي **مورّد** — لا أداةٌ شغّلته. الحامل
    // (‏opencode) ليس اشتراكاً بذاته: استهلاكه يُنسب إلى مورّدي نماذجه، وما
    // خدمته بوّابته المستضافة يُنسب إلى `opencode-zen`.
    const entryByVendor = new Map<VendorKey, (typeof active)[number]>();
    for (const entry of active) {
      const vendor = harnessVendor(entry.provider);
      if (vendor && !entryByVendor.has(vendor)) {
        entryByVendor.set(vendor, entry);
      }
    }

    // مورّدون ظهروا في الاستهلاك ولا اشتراك مُصادَق عليه باسمهم — وهذا
    // بالضبط ما أخفى GLM: نماذجه تعمل عبر حامل، فلا يظهر في قائمة الأجسام
    // المُصادَق عليها أصلاً. يُكتشفون من نماذج الحامل نفسها بمسح واحد.
    //
    // والمسح مقصورٌ على الحوامل **الحاضرة في هذا الحساب** لا على كل حامل
    // معروف: قراءة قاعدة حامل غير مُصادَق عليه تفتح ملفّاً لا علاقة له
    // بالمستخدم (وهو ما جعل بيانات جهاز حقيقية تتسرّب إلى بيئة اختبار معزولة).
    const discovered = new Set<VendorKey>();
    for (const entry of active) {
      if (!MEASURABLE_PROVIDERS.has(entry.provider)) {
        continue;
      }
      const probeCycle = resolveBillingCycle(entry.anchorDay, now);
      const collected = await collectHarnessCycleCostsMemo(collectionMemo, entry.provider, userId, probeCycle);
      for (const cost of collected.costs) {
        for (const row of cost.perModel) {
          const vendor = resolveModelVendor(row.model, entry.provider);
          if (vendor !== 'unknown') {
            discovered.add(vendor);
          }
        }
      }
    }

    // ما أخفاه المالك يبقى مخفيّاً حتى لو اكتُشف استهلاكه عبر حامل: الاكتشاف
    // مصدرُ بطاقاتٍ جديدة، لا بابٌ خلفيّ يُعيد بطاقةً أُغلقت عمداً.
    const allEntries = await subscriptionConfigService.list(userId, deps);
    const hiddenVendors = new Set<VendorKey>();
    for (const entry of allEntries) {
      if (!entry.hidden) {
        continue;
      }
      const vendor = harnessVendor(entry.provider);
      if (vendor) {
        hiddenVendors.add(vendor);
      }
    }

    const vendors = new Set<VendorKey>(
      [...entryByVendor.keys(), ...discovered].filter((vendor) => !hiddenVendors.has(vendor)),
    );
    const views: SubscriptionCostView[] = [];

    for (const vendor of vendors) {
      const entry = entryByVendor.get(vendor);
      const anchorDay = entry?.anchorDay ?? 1;
      const cycle = resolveBillingCycle(anchorDay, now);

      const base = {
        provider: vendor,
        displayName: entry && harnessVendor(entry.provider) === vendor ? entry.displayName : vendorDisplayName(vendor),
        plan: entry?.plan ?? null,
        anchorDay,
        anchorSource: entry?.anchorSource ?? ('unknown' as BillingAnchorSource),
        anchorEvidence: entry?.anchorEvidence ?? null,
        anchorObservedAt: entry?.anchorObservedAt ?? null,
        cycleStart: cycle.start.toISOString(),
        cycleEnd: cycle.end.toISOString(),
        metered: await isMetered(entry?.provider ?? vendor, userId, deps),
      };

      const totals = await sumVendorCycle(vendor, userId, cycle, collectionMemo);

      // لا جسم قابلاً للقياس أسهم بشيء: يُقال «غير متاح» بسبب الجسم الطبيعي
      // لهذا المورّد — لا يُعرض صفرٌ يبدو قياساً.
      if (totals.byHarness.length === 0) {
        const natural = entry?.provider ?? vendor;
        if (!MEASURABLE_PROVIDERS.has(natural)) {
          views.push({
            ...base,
            available: false,
            reason: unmeasurableReason(natural),
            totalUsd: 0,
            sessions: 0,
            complete: false,
            unpricedModels: [],
          });
          continue;
        }
      }

      views.push({
        ...base,
        available: true,
        totalUsd: totals.totalUsd,
        sessions: totals.sessions,
        complete: totals.complete,
        unpricedModels: totals.unpricedModels,
        assumedModels: totals.assumedModels,
        byHarness: totals.byHarness,
      });
    }

    return views.sort((a, b) => b.totalUsd - a.totalUsd);
  },

  /** خطّاف اختبار: يُفرِغ كاش الكلفة. ليس على مسار الطلب. */
  _resetCache(): void {
    costCache.clear();
  },
};

/** يُعاد تصديره كي يقرأ مسارُ الاشتراكات تاريخَ الأسعار من مصدر واحد. */
export { PRICES_AS_OF };
