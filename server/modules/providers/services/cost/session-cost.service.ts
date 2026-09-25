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
 *    يبقى `null` — ادّعاء «فاتورة» أو «اشتراك» بلا دليل كلاهما مضلل.
 *
 *  • **لا تُقرأ محادثة مرّتين بلا سبب.** الكاش مفتاحه (المسار + بصمة التعديل +
 *    النافذة)، فملف لم يتغيّر لا يُقرأ ثانية، وملف نما يسقط مفتاحه تلقائياً.
 *    ومسح الدورة الشهرية يتخطّى — بـstat وحده — كل ملف لم يُكتب فيه شيء منذ
 *    بداية الدورة، فلا يُفتح أصلاً.
 */

import { readdir, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

import { participantsDb, responseTurnMetricsDb, sessionsDb, usageStatisticsV3ReaderMode } from '@/modules/database/index.js';
import {
  claudeProjectRoots,
  encodeClaudeProjectDir,
} from '@/modules/providers/list/claude/claude-transcript-path.js';
import {
  resolveCodexLinkedRollouts,
  type CodexRolloutManifest,
} from '@/modules/providers/list/codex/codex-rollout-links.js';
import { isProviderIsolated } from '@/services/provider-sharing.js';
import type {
  BillingAnchorSource,
  SessionCostMeasurement,
  SessionCostTurn,
} from '@/shared/types.js';

import { providerBalanceService } from '../usage/provider-balance.service.js';

import { breakdownFromSessionCosts, type ModelBreakdownRow } from './cost-breakdown.js';
import {
  calculateSessionCost,
  reconcileSessionCostTurnFloor,
  sumSessionCosts,
  type SessionCost,
} from './cost-calculator.js';
import { buildSessionTurns, type TurnMetricWindow } from './session-turns.js';
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
import { buildSessionAttribution, type UsageAttribution } from './usage-attribution.js';
import {
  probeProviderAuth,
  resolveBillingCycle,
  subscriptionConfigService,
  type BillingCycle,
  type SubscriptionDeps,
} from './subscription-config.service.js';
import {
  extractClaudeSessionUsage,
  extractCodexConversationUsage,
  type RequestUsageRecord,
  type TokenTotals,
  type UsageWindow,
} from './usage-extractors.js';
import {
  conversationSnapshotReaderMode,
  logSnapshotComparison,
  readConversationUsageSnapshot,
} from './usage-ingestion.service.js';
import {
  readReadyUsageV3,
  type ReadyUsageV3,
} from './usage-statistics-v3.service.js';

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
  /** true = مقيس؛ false = قيمة مكافئة؛ null = تعذر إثبات طريقة المصادقة. */
  metered: boolean | null;
  totalUsd: number;
  snapshotStatus: 'fresh' | 'stale' | 'refreshing' | 'incomplete' | 'unavailable';
  snapshotAsOf: string | null;
  snapshotReason?: string;
  complete: boolean;
  unpricedModels: string[];
  subagentRequests: number;
  /** مجموع مدد العمل المبلّغ عنها في نتائج الوكلاء/الأدوات، أو null إن غابت. */
  workDurationMs: number | null;
  /** عقدة القياس المنشورة؛ تجمع العدّادات والزمن ودليل اتساق الإجماليات. */
  measurement: import('@/shared/types.js').SessionCostMeasurement;
  pricesAsOf: string;
  perModel: SessionModelCostView[];
  /** تفصيل الكلفة لكل دور ردّ (اختياري)؛ الشرح في `SessionCostTurn`. */
  turns?: SessionCostTurn[];
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
  metered: boolean | null;
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
  /**
   * الرصيد المتبقّي لدى المزوّد حين يعلنه رسمياً (‏moonshot وحده اليوم).
   * ‏`null` = لا مصدر أو تعذّرت القراءة — ولا يُلفَّق صفراً، لأن صفر الرصيد
   * يُقرأ «نَفِد» وهو ادّعاء مختلف. مستقلٌّ عن `totalUsd`: ذاك ما أُنفِق في
   * الدورة، وهذا ما بقي في الحساب.
   */
  balanceUsd?: number | null;
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
  signal?: AbortSignal;
  /** Deterministic race seam for manifest/signature tests; production omits it. */
  afterCodexManifest?: () => Promise<void> | void;
  /** Deterministic race seam; production omits it. */
  afterV3Ready?: () => Promise<void> | void;
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

type TranscriptCostOutcome = {
  cost: SessionCost;
  snapshotStatus: 'fresh' | 'stale' | 'incomplete';
  snapshotAsOf: string | null;
  snapshotReason?: string;
};

type InflightCost = {
  controller: AbortController;
  promise: Promise<TranscriptCostOutcome>;
  refs: number;
};

const transcriptInflight = new Map<string, InflightCost>();

function joinTranscriptFlight(
  key: string,
  signal: AbortSignal | undefined,
  start: (signal: AbortSignal) => Promise<TranscriptCostOutcome>,
): Promise<TranscriptCostOutcome> {
  let flight = transcriptInflight.get(key);
  if (!flight) {
    const controller = new AbortController();
    const created = { controller, refs: 0 } as InflightCost;
    created.promise = start(controller.signal).finally(() => {
      if (transcriptInflight.get(key) === created) transcriptInflight.delete(key);
    });
    flight = created;
    transcriptInflight.set(key, flight);
  }
  flight.refs += 1;
  return new Promise((resolve, reject) => {
    let settled = false;
    const release = (): void => {
      if (settled) return;
      settled = true;
      signal?.removeEventListener('abort', onAbort);
      flight!.refs -= 1;
      if (flight!.refs === 0 && transcriptInflight.get(key) === flight) {
        transcriptInflight.delete(key);
        flight!.controller.abort();
      }
    };
    const onAbort = (): void => {
      release();
      reject(signal?.reason ?? new DOMException('Aborted', 'AbortError'));
    };
    if (signal?.aborted) return onAbort();
    signal?.addEventListener('abort', onAbort, { once: true });
    flight!.promise.then(
      (value) => { if (!settled) { release(); resolve(value); } },
      (error) => { if (!settled) { release(); reject(error); } },
    );
  });
}

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

const manifestFingerprint = (manifest?: CodexRolloutManifest): string => {
  if (!manifest) return 'none';
  return JSON.stringify({
    complete: manifest.complete,
    reason: manifest.limitReason,
    files: manifest.files.map((file) => [file.rolloutPath, file.size, file.mtimeMs, file.model]),
    links: manifest.linked.map((link) => [link.rolloutPath, link.spawn.callId, link.spawn.agentThreadId]),
  });
};

const metricsFingerprint = (sessionId: string | undefined, enabled: boolean): string => {
  if (!enabled || !sessionId) return 'none';
  try {
    return JSON.stringify(responseTurnMetricsDb.listSessionWindows(sessionId).map((row) => [
      row.assistantMessageId, row.startedAt, row.completedAt, row.durationMs,
    ]));
  } catch {
    // Metrics are display-only; a failed fingerprint must disable caching, not
    // reuse a potentially stale turn assignment.
    return `unavailable:${Date.now()}`;
  }
};

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
  /** False when current files no longer match the manifest-pinned pre-read stats. */
  stable: boolean;
};

/** يمشي المجلّد تنازلياً: أحدث تعديل ومجموع الأحجام. للمسار المفرد وحده. */
async function scanSubagentTree(
  directory: string,
  signal?: AbortSignal,
): Promise<{ newestMs: number; totalSize: number }> {
  let newestMs = 0;
  let totalSize = 0;

  const walk = async (current: string): Promise<void> => {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // لا مجلّد وكلاء فرعيين لهذه المحادثة.
    }
    signal?.throwIfAborted();
    for (const entry of entries) {
      signal?.throwIfAborted();
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
  options: { deep?: boolean; codexManifest?: CodexRolloutManifest; signal?: AbortSignal } = {},
): Promise<TranscriptSignature | null> {
  options.signal?.throwIfAborted();
  if (provider === 'codex' && options.deep && options.codexManifest) {
    let newestMs = 0;
    let size = 0;
    let stable = true;
    for (const pinned of options.codexManifest.files) {
      options.signal?.throwIfAborted();
      newestMs = Math.max(newestMs, pinned.mtimeMs);
      size += pinned.size;
      const current = await stat(pinned.rolloutPath).catch(() => null);
      if (!current || current.size !== pinned.size || current.mtimeMs !== pinned.mtimeMs) stable = false;
    }
    return { newestMs, size, stable };
  }
  let fileStat;
  try {
    fileStat = await stat(transcriptPath);
  } catch {
    options.signal?.throwIfAborted();
    return null;
  }
  options.signal?.throwIfAborted();
  if (!fileStat.isFile()) {
    return null;
  }

  let newestMs = fileStat.mtimeMs;
  let size = fileStat.size;

  if (provider === 'claude') {
    const subagentDirectory = transcriptPath.replace(/\.jsonl$/, '');
    if (options.deep) {
      const tree = await scanSubagentTree(subagentDirectory, options.signal);
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

  if (provider === 'codex' && options.deep) {
    try {
      const tree = options.codexManifest ?? await resolveCodexLinkedRollouts(transcriptPath, options.signal);
      for (const child of tree.linked) {
        options.signal?.throwIfAborted();
        try {
          const childStat = await stat(child.rolloutPath);
          newestMs = Math.max(newestMs, childStat.mtimeMs);
          size += childStat.size;
        } catch {
          // ملف ابن اختفى بعد قراءة رابط الأب؛ القراءة التالية ستعيد الحلّ.
        }
      }
    } catch {
      options.signal?.throwIfAborted();
      // سجلّ ناقص/قيد الكتابة: تبقى بصمة الأب صالحةً ويعود المستخرج بما قرأ.
    }
  }

  return { newestMs, size, stable: true };
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

  const encoded = encodeClaudeProjectDir(row.project_path);
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

/**
 * يقرأ كلفة سجلّ واحد عبر الكاش. المفتاح يحمل البصمة فلا يُخدم رقم قديم.
 *
 * ‏`attributedTo` جزءٌ من المفتاح **إلزاماً** لا تحسيناً: الكلفة المنسوبة إلى
 * مستخدم تختلف عن الكلفة الكاملة لنفس الملف بنفس البصمة، فمفتاح لا يحمل هوية
 * المستخدم يُقدِّم رقم أحدهما للآخر — تسريبُ رقمٍ عبر المستخدمين، لا مجرّد
 * رقمٍ بائت.
 */
/**
 * يردّ المعرّف المطبَّع المخزَّن في `response_turn_metrics` إلى **`raw.uuid`
 * المجرّد** الذي تحمله `message.transcriptMessageId` في الواجهة، فيتّحد فضاء
 * المفاتيح. لـClaude المطبَّع `${raw.uuid}_${partIndex}` (claude-sessions.
 * provider.ts) فتُقتطع اللاحقة؛ ولمزوّدات CLI أخرى قد يكون `msg.id`/`item_...`
 * فيُترك كما هو. القاعدة: إن بدأ بـUUID متبوعٍ بـ`_` فالمجرّد هو الـUUID.
 */
const UUID_PREFIX = /^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})_/i;
export function bareTranscriptMessageId(storedId: string): string {
  const match = UUID_PREFIX.exec(storedId);
  return match ? match[1] : storedId;
}

/**
 * يبني تفصيل الأدوار لجلسة: يقرأ **كل** نوافذ `response_turn_metrics` للجلسة
 * (لا يطابق بالمعرّف — الفضاء المخزَّن مطبَّع لا مجرّد)، ويطبّع مفتاح كلٍّ إلى
 * `raw.uuid` المجرّد، ثم يفوّض للدالّة الصرفة. أي خطأ قراءة لا يُسقط الكلفة —
 * الأدوار تحسين عرض، فيُتخطّى بصمت.
 */
export function turnsForSession(
  sessionId: string,
  requests: readonly RequestUsageRecord[],
  userBoundariesMs: readonly number[],
): SessionCostTurn[] | undefined {
  try {
    const metricRows = responseTurnMetricsDb.listSessionWindows(sessionId);
    const durationsByMessageId = new Map(metricRows.map((row) => [
      bareTranscriptMessageId(row.assistantMessageId), row.durationMs,
    ]));
    const windows: TurnMetricWindow[] = metricRows
      .map((row) => ({
        assistantMessageId: bareTranscriptMessageId(row.assistantMessageId),
        startedAt: row.startedAt,
        completedAt: row.completedAt,
      }));
    const turns = buildSessionTurns(requests, windows, userBoundariesMs).map((turn) => ({
      ...turn,
      responseTurnDurationMs: durationsByMessageId.get(turn.assistantMessageId) ?? null,
    }));
    return turns.length > 0 ? turns : undefined;
  } catch (error) {
    console.warn('[session-cost-turns]', {
      sessionId,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

async function costForTranscript(
  provider: string,
  transcriptPath: string,
  signature: TranscriptSignature,
  window?: UsageWindow,
  attribution?: { userId: number; filter: UsageAttribution },
  options: { manifest?: CodexRolloutManifest; signal?: AbortSignal; sessionId?: string } = {},
): Promise<TranscriptCostOutcome> {
  const scopeKey = attribution ? `u${attribution.userId}` : 'all';
  // تفصيل الأدوار يخصّ عرض المحادثة الكاملة وحده: لا نافذة (دورة شهرية) ولا نسبة
  // (نطاق مستخدم). غيابه لا يغيّر أي رقم إجمالي. كودكس يسجّل العدّاد
  // تراكميّاً، لكن المستخرج يفكّه إلى `last_token_usage` لكل دور هنا.
  const captureTurns = !window && !attribution && Boolean(options.sessionId);
  const canonicalPath = await realpath(transcriptPath).catch(() => transcriptPath);
  const metricsBefore = metricsFingerprint(options.sessionId, captureTurns);
  const key = [
    provider,
    options.sessionId ?? canonicalPath,
    manifestFingerprint(options.manifest),
    windowKey(window),
    scopeKey,
    captureTurns ? 'turns' : 'summary',
    metricsBefore,
    PRICES_AS_OF,
    signature.newestMs,
    signature.size,
  ].join('|');
  const cached = cacheGet(key);
  // An incomplete manifest must never inherit a formerly complete snapshot
  // whose child disappeared without changing the root rollout fingerprint.
  if (cached && signature.stable && options.manifest?.complete !== false) {
    return {
      cost: cached,
      snapshotStatus: 'fresh',
      snapshotAsOf: new Date(signature.newestMs).toISOString(),
      ...(options.manifest?.limitReason ? { snapshotReason: options.manifest.limitReason } : {}),
    };
  }
  return joinTranscriptFlight(key, options.signal, async (flightSignal) => {
    const usage = provider === 'codex'
      ? await extractCodexConversationUsage(transcriptPath, window, {
          manifest: options.manifest,
          signal: flightSignal,
          captureRequests: captureTurns,
        })
      : await extractClaudeSessionUsage(transcriptPath, window, attribution?.filter, flightSignal, { captureRequests: captureTurns });
    let cost = calculateSessionCost(usage);
    if (captureTurns && options.sessionId && usage.requests && usage.requests.length > 0) {
      const turns = turnsForSession(options.sessionId, usage.requests, usage.userBoundariesMs ?? []);
      if (turns) {
        // This path is intentionally full-conversation only: captureTurns is
        // false for billing windows and user-attributed reads, so their
        // independent counters are never mixed with displayed turn costs.
        // Legacy remains authoritative while v3 is dormant. Reconcile the
        // same full-conversation aggregate and turn set by taking the floor,
        // never by summing the two views of the same usage.
        cost = reconcileSessionCostTurnFloor(cost, turns);
        cost.turns = turns;
      }
    }
    const post = await transcriptSignature(provider, transcriptPath, {
      deep: true,
      signal: flightSignal,
      ...(provider === 'codex' && options.manifest ? { codexManifest: options.manifest } : {}),
    });
    const metricsStable = metricsFingerprint(options.sessionId, captureTurns) === metricsBefore;
    const stable = signature.stable && post?.stable === true && metricsStable &&
      post.newestMs === signature.newestMs && post.size === signature.size;
    const snapshotStatus = usage.snapshotStatus === 'incomplete' || !stable ? 'incomplete' : 'fresh';
    const snapshotReason = usage.snapshotReason ?? (!stable
      ? metricsStable
        ? 'The transcript changed while its snapshot was being read.'
        : 'Response-turn metrics changed while their snapshot was being read.'
      : undefined);
    if (stable && snapshotStatus === 'fresh') cacheSet(key, cost);
    return {
      cost,
      snapshotStatus,
      snapshotAsOf: stable ? new Date(post.newestMs).toISOString() : null,
      ...(snapshotReason ? { snapshotReason } : {}),
    };
  });
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

const totalsEqual = (left: number, right: number): boolean => Math.abs(left - right) < 1e-9;

const tokensEqual = (
  left: TokenTotals,
  right: TokenTotals,
): boolean => left.input === right.input && left.output === right.output
  && left.cacheWrite5m === right.cacheWrite5m && left.cacheWrite1h === right.cacheWrite1h
  && left.cacheRead === right.cacheRead;

const emptyTokenTotals = (): TokenTotals => ({
  input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0,
});

const addTokens = (target: TokenTotals, source: TokenTotals): void => {
  target.input += source.input;
  target.output += source.output;
  target.cacheWrite5m += source.cacheWrite5m;
  target.cacheWrite1h += source.cacheWrite1h;
  target.cacheRead += source.cacheRead;
};

type MeasurementSource = Pick<ReadyUsageV3, 'facts' | 'window' | 'attribution' | 'counts' | 'durations'>;

const matched = (value: boolean): SessionCostMeasurement['reconciliation']['totalUsd'] =>
  value ? 'matched' : 'mismatch';

const sourceRolloutCount = (source: MeasurementSource, subagentOnly = false): number => new Set(source.facts
  .filter((fact) => !subagentOnly || fact.isSubagent)
  .map((fact) => fact.evidence.sourceKey)).size;

const withMeasurementStatus = (
  measurement: Omit<SessionCostMeasurement, 'status'>,
): SessionCostMeasurement => ({
  ...measurement,
  status: Object.values(measurement.reconciliation).every((value) => value === 'matched')
    ? 'complete'
    : 'incomplete',
});

/** Builds the v2 wire envelope from the exact cost rows being returned. */
const measurementFor = (
  cost: SessionCost,
  turns: readonly SessionCostTurn[] | undefined,
  source?: MeasurementSource,
): SessionCostMeasurement => {
  const perModelUsd = cost.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
  const requestCount = cost.perModel.reduce((sum, row) => sum + row.requests, 0);
  const rollouts = source?.counts.rolloutCount ?? null;
  const responseTurnsMs = turns && turns.length > 0
    ? turns.reduce<number | null>((sum, turn) => sum === null || turn.responseTurnDurationMs === null || turn.responseTurnDurationMs === undefined
      ? null : sum + turn.responseTurnDurationMs, 0)
    : null;
  const base = {
    version: 2 as const,
    source: source ? 'v3' as const : 'legacy' as const,
    window: source ? { ...source.window } : { since: null, until: null },
    attribution: source ? { ...source.attribution } : null,
    counts: {
      facts: source?.counts.facts ?? null,
      requests: source?.counts.requests ?? requestCount,
      rollouts,
      subagentSpawns: source?.counts.subagentSpawnCount ?? null,
      subagentRollouts: source?.counts.subagentRolloutCount ?? null,
      subagentRequests: source?.counts.subagentRequestCount ?? cost.subagentRequests,
    },
    durations: {
      workMs: source?.durations.workDurationMs ?? cost.workDurationMs,
      responseTurnsMs,
    },
  };
  if (!turns || turns.length === 0) {
    return withMeasurementStatus({
      ...base,
      reconciliation: {
        totalUsd: totalsEqual(cost.totalUsd, perModelUsd) ? 'matched' : 'mismatch',
        perModel: totalsEqual(cost.totalUsd, perModelUsd) ? 'matched' : 'mismatch',
        turns: 'unavailable',
        counts: source
          ? matched(requestCount === source.counts.requests
            && cost.subagentRequests === source.counts.subagentRequestCount
            && source.counts.subagentRequests === source.counts.subagentRequestCount
            && sourceRolloutCount(source) === source.counts.rolloutCount
            && sourceRolloutCount(source, true) === source.counts.subagentRolloutCount)
          : 'matched',
        durations: source && source.durations.workDurationMs !== cost.workDurationMs ? 'mismatch' : 'unavailable',
        eventSets: source
          ? matched(new Set(source.facts.map((fact) => fact.eventKey)).size === source.counts.facts)
          : 'unavailable',
        tokens: 'unavailable',
      },
    });
  }
  const modelTokens = emptyTokenTotals();
  const turnTokens = emptyTokenTotals();
  for (const row of cost.perModel) addTokens(modelTokens, row.tokens);
  for (const turn of turns) addTokens(turnTokens, turn.tokens);
  const turnUsd = turns.reduce((sum, turn) => sum + (turn.costUsd ?? 0), 0);
  return withMeasurementStatus({
    ...base,
    reconciliation: {
      totalUsd: totalsEqual(cost.totalUsd, perModelUsd) && totalsEqual(cost.totalUsd, turnUsd) ? 'matched' : 'mismatch',
      perModel: totalsEqual(cost.totalUsd, perModelUsd) ? 'matched' : 'mismatch',
      turns: totalsEqual(cost.totalUsd, turnUsd) ? 'matched' : 'mismatch',
      counts: source
        ? matched(requestCount === source.counts.requests
          && cost.subagentRequests === source.counts.subagentRequestCount
          && source.counts.subagentRequests === source.counts.subagentRequestCount
          && sourceRolloutCount(source) === source.counts.rolloutCount
          && sourceRolloutCount(source, true) === source.counts.subagentRolloutCount)
        : 'matched',
      durations: source && source.durations.workDurationMs !== cost.workDurationMs ? 'mismatch' : 'matched',
      eventSets: source
        ? matched(new Set(source.facts.map((fact) => fact.eventKey)).size === source.counts.facts)
        : 'unavailable',
      tokens: tokensEqual(modelTokens, turnTokens) ? 'matched' : 'mismatch',
    },
  });
};

/** نسخة خارجية من الكلفة المخبَّأة — لا يُسلَّم مرجع داخلي قابل للتعديل. */
const toSessionCostView = (
  sessionId: string,
  provider: string,
  cost: SessionCost,
  metered: boolean | null,
  snapshot: Pick<TranscriptCostOutcome, 'snapshotStatus' | 'snapshotAsOf' | 'snapshotReason'> = {
    snapshotStatus: 'fresh',
    snapshotAsOf: null,
  },
  measurementSource?: MeasurementSource,
  comparison?: SessionCostMeasurement['comparison'],
): SessionCostView => {
  const measurement = measurementFor(cost, cost.turns, measurementSource);
  return {
    sessionId,
    provider,
    available: true,
    metered,
    totalUsd: cost.totalUsd,
    snapshotStatus: snapshot.snapshotStatus,
    snapshotAsOf: snapshot.snapshotAsOf,
    ...(snapshot.snapshotReason ? { snapshotReason: snapshot.snapshotReason } : {}),
    complete: cost.complete,
    unpricedModels: [...cost.unpricedModels],
    subagentRequests: cost.subagentRequests,
    workDurationMs: cost.workDurationMs,
    measurement: comparison ? { ...measurement, comparison } : measurement,
    pricesAsOf: cost.pricesAsOf,
    perModel: cost.perModel.map((entry) => ({
      model: entry.model,
      costUsd: entry.costUsd,
      requests: entry.requests,
      tokens: { ...entry.tokens },
    })),
    ...(cost.turns ? { turns: cost.turns.map((turn) => ({ ...turn, models: [...turn.models], tokens: { ...turn.tokens } })) } : {}),
  };
};

const unavailableSessionCost = (sessionId: string, provider: string, reason: string): SessionCostView => ({
  sessionId,
  provider,
  available: false,
  reason,
  metered: false,
  totalUsd: 0,
  snapshotStatus: 'unavailable',
  snapshotAsOf: null,
  snapshotReason: reason,
  complete: false,
  unpricedModels: [],
  subagentRequests: 0,
  workDurationMs: null,
  measurement: {
    version: 2,
    status: 'incomplete',
    source: 'legacy',
    window: { since: null, until: null },
    attribution: null,
    counts: {
      facts: null, requests: 0, rollouts: null, subagentSpawns: null,
      subagentRollouts: null, subagentRequests: 0,
    },
    durations: { workMs: null, responseTurnsMs: null },
    reconciliation: {
      totalUsd: 'unavailable', perModel: 'unavailable', turns: 'unavailable', counts: 'unavailable',
      durations: 'unavailable', eventSets: 'unavailable', tokens: 'unavailable',
    },
  },
  pricesAsOf: PRICES_AS_OF,
  perModel: [],
});

type V3TurnProjection = { turns: SessionCostTurn[]; responseTurnsMs: number };

/**
 * v3 facts have no display message id.  Their timestamps are therefore joined
 * only to exactly one durable response window; a missing or ambiguous window
 * makes the projection unavailable rather than inventing a turn boundary.
 */
const turnsForReadyV3 = (sessionId: string, ready: ReadyUsageV3): V3TurnProjection | null => {
  const metrics = responseTurnMetricsDb.listSessionWindows(sessionId);
  if (metrics.length === 0) return null;
  const normalized = metrics.map((metric) => ({
    ...metric,
    assistantMessageId: bareTranscriptMessageId(metric.assistantMessageId),
    startMs: Date.parse(metric.startedAt),
    endMs: Date.parse(metric.completedAt),
  }));
  if (normalized.some((metric) => !Number.isFinite(metric.startMs) || !Number.isFinite(metric.endMs)
    || metric.endMs < metric.startMs)
    || new Set(normalized.map((metric) => metric.assistantMessageId)).size !== normalized.length) return null;

  const subagentsByTurn = new Map<string, number>();
  const requests: RequestUsageRecord[] = [];
  for (const fact of ready.facts) {
    const timestampMs = Date.parse(fact.occurredAt);
    if (!Number.isFinite(timestampMs)) return null;
    const matches = normalized.filter((metric) => timestampMs >= metric.startMs && timestampMs <= metric.endMs);
    if (matches.length !== 1) return null;
    const metric = matches[0];
    if (fact.isSubagent) {
      subagentsByTurn.set(metric.assistantMessageId, (subagentsByTurn.get(metric.assistantMessageId) ?? 0) + fact.requestCount);
    }
    requests.push({
      uuid: fact.eventKey,
      model: fact.model,
      timestampMs,
      firstTimestampMs: timestampMs,
      isSubagent: fact.isSubagent,
      totals: {
        input: fact.inputTokens - fact.cachedInputTokens,
        cacheRead: fact.cachedInputTokens,
        output: fact.outputTokens,
        cacheWrite5m: 0,
        cacheWrite1h: 0,
      },
    });
  }
  const durationsByTurn = new Map(normalized.map((metric) => [metric.assistantMessageId, metric.durationMs]));
  const turns = buildSessionTurns(requests, normalized, []).map((turn) => ({
    ...turn,
    responseTurnDurationMs: durationsByTurn.get(turn.assistantMessageId) ?? null,
    subagentRequests: subagentsByTurn.get(turn.assistantMessageId) ?? 0,
  }));
  const trustedIds = new Set(normalized.map((metric) => metric.assistantMessageId));
  if (turns.length !== normalized.length || turns.some((turn) => !trustedIds.has(turn.assistantMessageId)
    || turn.responseTurnDurationMs === null)) return null;
  return { turns, responseTurnsMs: turns.reduce((sum, turn) => sum + (turn.responseTurnDurationMs ?? 0), 0) };
};

const v3CostFor = (sessionId: string, ready: ReadyUsageV3): { cost: SessionCost; projection: V3TurnProjection | null } => {
  const cost = calculateSessionCost(ready.usage);
  const projection = turnsForReadyV3(sessionId, ready);
  if (projection) cost.turns = projection.turns;
  return { cost, projection };
};

const isCompleteV3Measurement = (measurement: SessionCostMeasurement): boolean =>
  Object.values(measurement.reconciliation).every((status) => status === 'matched');

/**
 * Compare mode is diagnostic only: it never replaces the legacy response.
 * The v1 extractor has no durable event-key domain, so event-set parity is
 * explicitly unavailable until both sides share one, rather than guessed from
 * timestamps or model labels.
 */
type V3Parity = NonNullable<SessionCostMeasurement['comparison']>;

const v3Parity = (sessionId: string, legacy: SessionCost, ready: ReadyUsageV3): V3Parity => {
  const legacyMeasurement = measurementFor(legacy, legacy.turns);
  const { cost: v3Cost } = v3CostFor(sessionId, ready);
  const v3Measurement = measurementFor(v3Cost, v3Cost.turns, ready);
  const sameModels = JSON.stringify([...legacy.perModel].sort((left, right) => left.model.localeCompare(right.model)))
    === JSON.stringify([...v3Cost.perModel].sort((left, right) => left.model.localeCompare(right.model)));
  const sameTurns = JSON.stringify(legacy.turns ?? []) === JSON.stringify(v3Cost.turns ?? []);
  const sameCounts = legacyMeasurement.counts.requests === v3Measurement.counts.requests
    && legacyMeasurement.counts.subagentRequests === v3Measurement.counts.subagentRequests;
  const sameDurations = (legacyMeasurement.durations.workMs === null
    || legacyMeasurement.durations.workMs === v3Measurement.durations.workMs)
    && (legacyMeasurement.durations.responseTurnsMs === null
      || legacyMeasurement.durations.responseTurnsMs === v3Measurement.durations.responseTurnsMs);
  const sameFlags = legacy.complete === v3Cost.complete
    && JSON.stringify([...legacy.unpricedModels].sort()) === JSON.stringify([...v3Cost.unpricedModels].sort())
    && JSON.stringify([...legacy.assumedModels].sort()) === JSON.stringify([...v3Cost.assumedModels].sort())
    && legacy.pricesAsOf === v3Cost.pricesAsOf;
  if (!totalsEqual(legacy.totalUsd, v3Cost.totalUsd)) return { status: 'mismatch', reason: 'total_usd' };
  if (!sameModels) return { status: 'mismatch', reason: 'per_model_or_tokens' };
  if (!sameTurns) return { status: 'mismatch', reason: 'turns' };
  if (!sameCounts) return { status: 'mismatch', reason: 'shared_counts' };
  if (!sameDurations) return { status: 'mismatch', reason: 'shared_durations' };
  if (!sameFlags) return { status: 'mismatch', reason: 'pricing_coverage_or_prices_as_of' };
  if (!isCompleteV3Measurement(v3Measurement)) return { status: 'mismatch', reason: 'v3_internal_reconciliation' };
  return { status: 'matched' };
};

const meteredCache = new Map<string, { value: boolean | null; expiresAt: number }>();
const meteredInflight = new Map<string, Promise<boolean | null>>();
const VERIFIED_SUBSCRIPTION_AUTH_METHODS = new Set([
  'credentials_file',
  'oauth',
  'oauth_token',
  'google-oauth',
  'cli',
  'coding_plan',
]);

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
): Promise<boolean | null> {
  const cacheable = deps.probeAuth === undefined;
  const key = `${provider}|${userId ?? 'anonymous'}`;
  if (cacheable) {
    const cached = meteredCache.get(key);
    if (cached && cached.expiresAt > Date.now()) return cached.value;
    const pending = meteredInflight.get(key);
    if (pending) return pending;
  }
  const probe = (async () => {
  try {
    const status = await probeProviderAuth(provider, userId, deps);
    if (!status.available || !status.authenticated || status.method === null) return null;
    if (status.method === 'api_key') return true;
    return VERIFIED_SUBSCRIPTION_AUTH_METHODS.has(status.method) ? false : null;
  } catch {
    return null;
  }
  })();
  if (!cacheable) return probe;
  meteredInflight.set(key, probe);
  try {
    const value = await probe;
    meteredCache.set(key, { value, expiresAt: Date.now() + 30_000 });
    return value;
  } finally {
    if (meteredInflight.get(key) === probe) meteredInflight.delete(key);
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
  const numericId = numericUserId(userId);
  if (numericId === null) {
    return new Set<string>();
  }
  return new Set(participantsDb.getSessionIdsForUser(numericId));
}

/** مُعرِّف المستخدم عدداً صحيحاً، أو null حين لا هوية صالحة (مجهول/غير محلول). */
function numericUserId(userId: string | number | null): number | null {
  const parsed = typeof userId === 'number' ? userId : Number(userId);
  return Number.isInteger(parsed) ? parsed : null;
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

/**
 * مسح سجلّات مزوّد داخل دورة، منسوبةً إلى مستخدم بعينه.
 *
 * **مسحٌ واحد لمستدعيَين** عمداً: كان الحساب يتكرّر حرفياً في
 * `collectHarnessCycleCosts` (مسار بطاقات الاشتراكات) وفي `sumProviderCycle`
 * (مسار مورّد بعينه). التوأمة نفسها هي التي جعلت أول تطبيق للنسبة يمرّ على
 * أحدهما ويترك الآخر يعرض الرقم القديم — والاختبارات كانت خضراء. فوحدةُ
 * الموضع هنا ليست ترتيباً، بل الضمانة الوحيدة أن أي قاعدة نسبةٍ تصل المسارين.
 */
async function scanTranscriptCycle(
  provider: string,
  userId: string | number | null,
  cycle: BillingCycle,
): Promise<{ costs: SessionCost[]; missingTranscripts: number }> {
  const cycleStartMs = cycle.start.getTime();
  const window: UsageWindow = { since: cycleStartMs, until: cycle.end.getTime() };
  const scope = sessionScope(provider, userId);
  // النسبة تُطبَّق حيث يُطبَّق النطاق: مزوّد **معزول** لكل مستخدم اعتماده،
  // فلكل مستخدم رقمه. ومزوّد **مشترك** اشتراكه واحد ⇒ مجموع الجهاز هو الرقم
  // الوحيد ذو المعنى، وقسمته تُنقصه (القرار الموصوف في `sessionScope`).
  const attributedTo = scope === null ? null : numericUserId(userId);

  const costs: SessionCost[] = [];
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

    // `buildSessionAttribution` تعود null حين لا نسبة مطلوبة ⇒ تُحسب المحادثة
    // كاملةً، وهو سلوك ما قبل هذه الميزة بالضبط.
    const filter = attributedTo === null ? null : buildSessionAttribution(row.session_id, attributedTo);
    const { cost } = await costForTranscript(
      provider,
      row.jsonl_path,
      signature,
      window,
      filter && attributedTo !== null ? { userId: attributedTo, filter } : undefined,
    );

    // محادثة بلا مساهمة داخل النافذة ليست «محادثة هذه الدورة» ولا تُعدّ. وبعد
    // النسبة صار هذا يشمل حالةً جديدة ومقصودة: محادثة يشارك فيها المستخدم ولم
    // يستهلك فيها شيئاً (دخلها بعد أن أُنفق فيها المال) — لا تُعدّ له محادثة
    // ولا يُحمَّل مالها.
    if (cost.perModel.length === 0) {
      continue;
    }
    costs.push(cost);
  }

  return { costs, missingTranscripts };
}

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

  const scanned = await scanTranscriptCycle(harness, userId, cycle);
  return { costs: scanned.costs, complete: scanned.missingTranscripts === 0 };
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

  const { costs, missingTranscripts } = await scanTranscriptCycle(provider, userId, cycle);

  // التفصيل يُبنى من نفس المحادثات المساهِمة، فمجموع صفوفه هو الإجمالي نفسه
  // بنيوياً لا مصادفةً — رقمان محسوبان بطريقين يفترقان حتماً.
  const breakdown = breakdownFromSessionCosts(provider, costs);
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

    const v3ReaderMode = provider === 'codex' ? usageStatisticsV3ReaderMode() : 'off';
    const readsV3 = v3ReaderMode === 'on' || v3ReaderMode === 'compare';
    const v3MetricsBefore = readsV3 ? metricsFingerprint(sessionId, true) : 'none';
    const v3Ready = !readsV3 ? null : readReadyUsageV3({
      sessionId, scopeFingerprint: 'all', attributionFingerprint: 'none', metricsFingerprint: v3MetricsBefore,
    } as Parameters<typeof readReadyUsageV3>[0] & { metricsFingerprint: string });
    if (readsV3) await deps.afterV3Ready?.();
    const v3MetricsStable = (): boolean => !readsV3 || metricsFingerprint(sessionId, true) === v3MetricsBefore;
    if (v3ReaderMode === 'on') {
      if (!v3Ready || !v3MetricsStable()) {
        return unavailableSessionCost(sessionId, provider, 'Codex v3 statistics are not ready for this exact metrics snapshot.');
      }
      const { cost: v3Cost, projection } = v3CostFor(sessionId, v3Ready);
      if (v3Cost.perModel.length === 0) return unavailableSessionCost(sessionId, provider, 'Codex v3 records no token facts.');
      if (!projection) return unavailableSessionCost(sessionId, provider, 'Codex v3 facts cannot be joined to complete response-turn metrics.');
      const measurement = measurementFor(v3Cost, v3Cost.turns, v3Ready);
      if (!isCompleteV3Measurement(measurement) || !v3MetricsStable()) {
        return unavailableSessionCost(sessionId, provider, 'Codex v3 does not attest a complete reconciled measurement.');
      }
      return toSessionCostView(sessionId, provider, v3Cost, await isMetered(provider, userId, deps), {
        snapshotStatus: 'fresh', snapshotAsOf: v3Ready.window.until,
      }, v3Ready);
    }

    const readerMode = conversationSnapshotReaderMode();
    const ledger = readerMode === 'legacy' ? null : readConversationUsageSnapshot(sessionId);
    if (readerMode === 'ledger' && ledger) {
      const snapshotStatus = ledger.snapshot.snapshotStatus === 'ready' && ledger.snapshot.ingestComplete
        ? 'fresh' as const
        : ledger.snapshot.snapshotStatus === 'stale' ? 'stale' as const : 'incomplete' as const;
      return toSessionCostView(
        sessionId,
        provider,
        ledger.cost,
        await isMetered(provider, userId, deps),
        {
          snapshotStatus,
          snapshotAsOf: ledger.snapshot.asOf ?? null,
          ...(ledger.snapshot.errorMessage ? { snapshotReason: ledger.snapshot.errorMessage } : {}),
        },
      );
    }
    if (readerMode === 'ledger' && !ledger) {
      return unavailableSessionCost(
        sessionId,
        provider,
        'The usage snapshot is unavailable or invalid; background ingestion will refresh it independently.',
      );
    }

    // Legacy/compare alone inspect transcript trees. Ledger mode above remains
    // a constant-size DB read and never resolves a Codex manifest on the GET.
    let codexManifest: CodexRolloutManifest | undefined;
    if (provider === 'codex') {
      codexManifest = await resolveCodexLinkedRollouts(transcriptPath, deps.signal);
      await deps.afterCodexManifest?.();
      deps.signal?.throwIfAborted();
    }

    const signature = await transcriptSignature(provider, transcriptPath, {
      deep: true,
      signal: deps.signal,
      ...(codexManifest ? { codexManifest } : {}),
    });
    if (!signature) {
      return unavailableSessionCost(sessionId, provider, 'The transcript file for this conversation is no longer on disk.');
    }

    const outcome = await costForTranscript(provider, transcriptPath, signature, undefined, undefined, {
      ...(codexManifest ? { manifest: codexManifest } : {}),
      signal: deps.signal,
      sessionId,
    });
    const cost = outcome.cost;

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
    let comparison: V3Parity | undefined;
    if (v3ReaderMode === 'compare' && v3Ready && v3MetricsStable()) {
      const { cost: v3Cost } = v3CostFor(sessionId, v3Ready);
      comparison = v3Parity(sessionId, cost, v3Ready);
      if (comparison.status !== 'matched') logSnapshotComparison(sessionId, cost, v3Cost);
    }
    if (readerMode === 'compare' && ledger) logSnapshotComparison(sessionId, cost, ledger.cost);
    return toSessionCostView(sessionId, provider, cost, metered, outcome, undefined, comparison);
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

      // الرصيد المتبقّي من المزوّد نفسه — مستقلٌّ عن مسح السجلّ تماماً: مورّدٌ
      // بلا استهلاك مقيس في الدورة قد يكون له رصيدٌ معلَن، والعكس. لذلك يُقرأ
      // قبل فرع «غير متاح» لا بعده، فبطاقةُ «لا استهلاك» تظلّ قادرة على قول
      // «يتبقّى لك كذا». وهو `null` صامت حين لا مصدر (كل المورّدين عدا moonshot).
      let balance = null;
      try {
        balance = await providerBalanceService.getBalance(vendor, userId);
      } catch (error) {
        if (!(error instanceof Error)
          || error.message !== 'BALANCE_AUTHENTICATED_EFFECT_RUNNER_REQUIRED') {
          throw error;
        }
        // This background aggregation has only a user id, not an authenticated
        // actor. Omit the live balance until its caller propagates a principal.
      }
      const balanceUsd = balance?.availableUsd ?? null;

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
            balanceUsd,
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
        balanceUsd,
      });
    }

    return views.sort((a, b) => b.totalUsd - a.totalUsd);
  },

  /** خطّاف اختبار: يُفرِغ كاش الكلفة. ليس على مسار الطلب. */
  _resetCache(): void {
    costCache.clear();
    meteredCache.clear();
    meteredInflight.clear();
    for (const flight of transcriptInflight.values()) flight.controller.abort();
    transcriptInflight.clear();
  },
};

/** يُعاد تصديره كي يقرأ مسارُ الاشتراكات تاريخَ الأسعار من مصدر واحد. */
export { PRICES_AS_OF };
