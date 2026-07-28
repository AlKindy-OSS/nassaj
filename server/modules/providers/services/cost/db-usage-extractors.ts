/**
 * استخراج الاستهلاك من مزوّدات تحفظه في **قاعدة SQLite** لا في JSONL.
 *
 * هذه الطبقة توأم `usage-extractors.ts` شكلاً ومسؤوليةً: تُخرج نفس
 * `SessionUsage` بنفس عدّادات `TokenTotals`، ويتولّى `cost-calculator` تسعيرها.
 * لا سعر واحد هنا ولا معادلة — الفصل نفسه المقصود في ADR-078.
 *
 * كل قاعدة أدناه **مقيسة على قاعدتي هذا الجهاز الحيّتين** (2026-07-28)، لا
 * مفترَضة من توثيق:
 *
 *  • **القراءة للقراءة فقط.** هاتان قاعدتا تطبيقين آخرين قد يكتبان فيهما الآن.
 *    كل فتح هنا `{ readonly: true, fileMustExist: true }`، وكل اتصال يُغلق في
 *    `finally`. قفلٌ منّا على قاعدة حيّة يُعطِّل جلسة جارية لغيرنا.
 *
 *  • **‏`cost` الجاهز لدى opencode لا يُصدَّق.** الصفّ الحقيقي
 *    `ses_059f6304…` يحمل `cost = 0` بينما توكنزه ‏43,803 مدخلاً و163,776
 *    قراءةً من المخبّأ. الأخذ به يطبع «0.00$» على محادثة كاملة — وهو بالضبط
 *    الرقم المُلفَّق الذي يمنعه ADR-078. القاعدة: **نُسعِّر التوكنز بجدولنا
 *    دائماً**، ونموذجٌ خارج الجدول يُدرَج في `unpricedModels` لا يُصفَّر. وميزة
 *    ثانية للقاعدة: كل مبلغ في نسّاج يبقى منسوباً لـ`PRICES_AS_OF` واحد، فلا
 *    يختلط سعر جدولنا بسعر مزوّد بتاريخ مجهول.
 *
 *  • **‏opencode حامل (carrier)**: عمود `model` نصٌّ JSON
 *    (`{"id":"glm-5.2","providerID":"glm"}`) يسمّي **النموذج الأصلي** لا
 *    «opencode». فالكلفة تُنسب إليه، والاسم المعروض `<providerID>/<id>` —
 *    و`normalizeModelId` يُسقط البادئة عند المطابقة، فيُسعَّر `glm/glm-5.2`
 *    بسعر `glm-5.2` ويظهر `opencode/big-pickle` غير مُسعَّر باسمه كاملاً.
 *
 *  • **‏`reasoning` لدى opencode بندٌ مستقلّ عن `output`** — لا جزء منه:
 *    رسالة حقيقية فيها `output:128` و`reasoning:553`، والتفكير أكبر من
 *    المخرجات فيستحيل أن يكون داخلها؛ و`total` يساوي مجموع البنود الخمسة في
 *    كل رسالة مقيسة. ⇒ المخرجات المُحاسَبة = `output + reasoning`.
 *    **وعكسه لدى Hermes**: مصدره `output_tokens_details.reasoning_tokens`
 *    (‏`agent/usage_pricing.py`) وهو **جزء من** `output_tokens` بدلالة OpenAI،
 *    وتسعير Hermes نفسه لا يضيفه. ⇒ لا يُضاف. الفرق حقيقي، وخلطه يضخّم أغلى
 *    بنود الفاتورة أو يُسقطه.
 *
 *  • **‏`input` في القاعدتين لا يشمل المخبّأ** (بخلاف كودكس): صفّ حقيقي فيه
 *    `input = 5008` و`cache_read = 6784`، والمدخلات أصغر من القراءة فيستحيل
 *    أن تكون شاملةً لها؛ ويؤكّده كود Hermes نفسه (يطرح المخبّأ صراحةً).
 *    ⇒ لا طرح هنا، بخلاف `extractCodexSessionUsage`.
 *
 *  • **دقّة النسبة الزمنية تختلف بين القاعدتين، وتُقال كما هي**:
 *    ‏opencode يحفظ **رسالةً رسالةً** بطابع لكل واحدة ⇒ نافذة الدورة تُرشَّح
 *    بطابع الرسالة تماماً كما في كلود. أما Hermes فلا يحفظ توكنز الرسالة
 *    (‏`messages.token_count` رقم واحد لا يفصل مدخلاً عن مخرج)، والعدّادات على
 *    مستوى الجلسة وحدها ⇒ **النسبة خشنة**: الجلسة كلّها تُنسب إلى لحظة
 *    `started_at`. جلسة Hermes ممتدّة عبر حدّ الدورة تقع كاملةً في دورة
 *    بدايتها. خشونة معلنة مقبولة، وخشونة صامتة ليست كذلك.
 */

import { stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import Database from 'better-sqlite3';

import { resolveOpenCodeDatabasePathForUser } from '@/modules/providers/list/opencode/opencode-home.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { readOptionalString } from '@/shared/utils.js';

import { emptyTotals, type ModelUsage, type SessionUsage, type UsageWindow } from './usage-extractors.js';

// ---------------------------------------------------------------------------
// العقد
// ---------------------------------------------------------------------------

/** نتيجة محادثة واحدة: إمّا قياس، وإمّا سببٌ مكتوب لغيابه. لا حالة ثالثة. */
export type DbSessionUsageOutcome =
  | { available: true; usage: SessionUsage }
  | { available: false; reason: string };

/** نتيجة مسح دورة: كل المحادثات المساهمة داخل النافذة، أو سبب الغياب. */
export type DbCycleUsageOutcome =
  | { available: true; sessions: SessionUsage[] }
  | { available: false; reason: string };

/** بصمة قاعدة على القرص — مفتاح إبطال الكاش لدى المستدعي. */
export type DatabaseSignature = { newestMs: number; size: number };

/**
 * لماذا لا تُقاس كلفة **محادثة Hermes بعينها** رغم أن أرقامها على القرص:
 * نسّاج يولّد مُعرِّف المحادثة بنفسه (`crypto.randomUUID()` في `hermes-cli.js`)
 * لأن `hermes -z` لا يُعيد مُعرِّفه الداخلي إطلاقاً، بينما `state.db` تُرقّم
 * جلساتها `YYYYMMDD_HHMMSS_xxxxxx`. لا مفتاح وصل بين الاثنين — والمطابقة
 * بالتقارب الزمني تخمينٌ يُعرض كأنه قياس. مجموع الدورة يبقى مقيساً لأنه لا
 * يحتاج ربطاً بمحادثة بعينها.
 */
export const HERMES_SESSION_UNLINKABLE_REASON =
  'Hermes stores its token counts in ~/.hermes/state.db, but it never reports its internal session id back to nassaj, so this conversation cannot be matched to a usage row. The subscription cycle total is still measured.';

const missingDatabaseReason = (provider: string, databasePath: string): string =>
  `No ${provider} usage database was found at ${databasePath}, so cost cannot be measured.`;

// ---------------------------------------------------------------------------
// مسارات القواعد (نفس سابقة العزل لكل مستخدم)
// ---------------------------------------------------------------------------

/**
 * قاعدة opencode لهذا المستخدم. تمرّ عبر `resolveOpenCodeDatabasePathForUser`
 * لا باشتقاق مسار جديد: هي نفسها التي يستعملها المُزامِن والمراقب، فلا يقرأ
 * حاسب الكلفة قاعدةً غير التي فُهرست منها المحادثات (عطب B-152 حرفياً).
 */
export function resolveOpenCodeCostDatabasePath(userId: string | number | null): string {
  return resolveOpenCodeDatabasePathForUser(userId);
}

/**
 * قاعدة Hermes لهذا المستخدم: `<HOME>/.hermes/state.db`. اعتماد Hermes مشترك
 * اليوم (‏`resolveProviderEnv` لا تُفرد له فرعاً فتعود ببيئة المشغّل)، فالمسار
 * واحد للجميع — والمرور بالمُحلِّل رغم ذلك مقصود: يوم يُعزل بـ`HOME` يتبعه هذا
 * القارئ بلا تعديل.
 */
export function resolveHermesCostDatabasePath(userId: string | number | null): string {
  let home: string | undefined;
  try {
    home = readOptionalString(resolveProviderEnv(userId, 'hermes', process.env).HOME);
  } catch {
    // فشل حلّ البيئة لا يمنع المسار الافتراضي أدناه.
  }
  return path.join(home ?? os.homedir(), '.hermes', 'state.db');
}

/**
 * بصمة قاعدة SQLite = أحدث تعديل ومجموع أحجام (الملف + `-wal` + `-shm`).
 * ملفّا WAL ليسا زينةً هنا: opencode يكتب في WAL دقائق طويلة قبل أن يمسّ
 * `opencode.db` نفسه، فبصمة الملف وحده تُجمّد الرقم على قيمة قديمة.
 */
export async function databaseSignature(databasePath: string): Promise<DatabaseSignature | null> {
  let newestMs = 0;
  let size = 0;
  let found = false;

  for (const candidate of [databasePath, `${databasePath}-wal`, `${databasePath}-shm`]) {
    try {
      const info = await stat(candidate);
      if (!info.isFile()) {
        continue;
      }
      if (candidate === databasePath) {
        found = true;
      }
      newestMs = Math.max(newestMs, info.mtimeMs);
      size += info.size;
    } catch {
      // ‏-wal/-shm يغيبان حين لا كاتب — غيابهما حالة طبيعية لا خطأ.
    }
  }

  return found ? { newestMs, size } : null;
}

// ---------------------------------------------------------------------------
// فتح للقراءة فقط
// ---------------------------------------------------------------------------

/**
 * يفتح القاعدة **للقراءة فقط ودون إنشاء**. القاعدة الغائبة أو التالفة تعود
 * `null` لا استثناءً: نافذة الكلفة جزء من شاشة المحادثة، ولا يجوز أن يُسقطها
 * غياب أداة خارجية.
 */
function openReadOnly(databasePath: string): Database.Database | null {
  try {
    return new Database(databasePath, { readonly: true, fileMustExist: true });
  } catch {
    return null;
  }
}

/** يضمن الإغلاق مهما خرج الاستعلام — اتصال متروك على قاعدة حيّة دَينٌ صامت. */
function withReadOnlyDatabase<T>(databasePath: string, run: (db: Database.Database) => T): T | null {
  const db = openReadOnly(databasePath);
  if (!db) {
    return null;
  }
  try {
    return run(db);
  } catch {
    return null;
  } finally {
    db.close();
  }
}

const withinWindow = (timestampMs: number, window?: UsageWindow): boolean => {
  if (!Number.isFinite(timestampMs)) {
    // صفّ بلا طابع صالح لا يُنسب إلى نافذة بعينها (لا يُحشر في الشهر الجاري).
    return !window || (window.since === undefined && window.until === undefined);
  }
  if (window?.since !== undefined && timestampMs < window.since) {
    return false;
  }
  return !(window?.until !== undefined && timestampMs >= window.until);
};

const readNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

type OpenCodeSessionRow = { id: string; parent_id: string | null; model: string | null; time_updated: number };
type OpenCodeMessageRow = { session_id: string; time_created: number; data: string };

/**
 * اسم النموذج كما يُعرض ويُسعَّر: `<providerID>/<modelID>` حين يُعرف الحامل.
 * البادئة ليست حشواً — هي التي تُظهر أن `big-pickle` نموذج opencode نفسه لا
 * نموذجٌ نسي أحدهم تسعيره؛ و`normalizeModelId` يُسقطها قبل المطابقة فلا تمنع
 * تسعير `glm/glm-5.2`.
 */
const openCodeModelLabel = (providerId: unknown, modelId: unknown): string => {
  const model = typeof modelId === 'string' ? modelId.trim() : '';
  if (!model) {
    return '';
  }
  const provider = typeof providerId === 'string' ? providerId.trim() : '';
  return provider ? `${provider}/${model}` : model;
};

/** نموذج الجلسة الافتراضي: عمود `model` نصُّ JSON لا اسمٌ مجرّد. */
function openCodeSessionModel(raw: string | null): string {
  if (!raw) {
    return '';
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    return isRecord(parsed) ? openCodeModelLabel(parsed.providerID, parsed.id) : '';
  } catch {
    return '';
  }
}

/**
 * يجمع رسائل مجموعة جلسات (الأمّ وأبناؤها) في `SessionUsage` واحد.
 * التجميع لكل نموذج لا لكل جلسة: محادثة واحدة قد تبدّل النموذج في منتصفها،
 * ونسبتها كلّها إلى نموذج الجلسة الأخير تُسعّر أدوارها القديمة بسعر خاطئ.
 */
function accumulateOpenCodeMessages(
  db: Database.Database,
  sessionIds: string[],
  rootId: string,
  fallbackModel: string,
  window?: UsageWindow,
): SessionUsage {
  const byModel = new Map<string, ModelUsage>();
  let subagentRequests = 0;

  const statement = db.prepare<[string], OpenCodeMessageRow>(
    'SELECT session_id, time_created, data FROM message WHERE session_id = ?',
  );

  for (const sessionId of sessionIds) {
    for (const row of statement.all(sessionId)) {
      if (!withinWindow(readNumber(row.time_created), window)) {
        continue;
      }

      let message: unknown;
      try {
        message = JSON.parse(row.data);
      } catch {
        continue; // صفّ تالف لا يُسقط المحادثة كلّها.
      }
      if (!isRecord(message) || message.role !== 'assistant') {
        continue;
      }

      const tokens = isRecord(message.tokens) ? message.tokens : null;
      if (!tokens) {
        continue; // رسالة بلا عدّاد (دور لم يكتمل) — لا تُحتسب ولا تُلفَّق.
      }

      const cache = isRecord(tokens.cache) ? tokens.cache : null;
      const input = readNumber(tokens.input);
      // ‏reasoning بندٌ مستقلّ لدى opencode (مقيس) ⇒ يُحاسَب مخرجاتٍ.
      const output = readNumber(tokens.output) + readNumber(tokens.reasoning);
      const cacheRead = readNumber(cache?.read);
      const cacheWrite = readNumber(cache?.write);
      if (input + output + cacheRead + cacheWrite === 0) {
        continue; // رسالة بعدّادات صفرية لا تُعدّ طلباً ولا تصنع نموذجاً وهمياً.
      }

      const model = openCodeModelLabel(message.providerID, message.modelID) || fallbackModel;
      if (!model) {
        continue; // بلا اسم نموذج لا تسعير ممكن ولا اسم يُعرض «غير مُسعَّر».
      }

      const current = byModel.get(model) ?? { model, totals: emptyTotals(), requests: 0 };
      current.totals.input += input;
      current.totals.output += output;
      // لا تقسيم 5د/ساعة في بيانات opencode ⇒ الكل على 5 دقائق، وهو الافتراضي
      // الرسمي لعمر المخبّأ (نفس قاعدة مُستخرِج كلود عند غياب التفصيل).
      current.totals.cacheWrite5m += cacheWrite;
      current.totals.cacheRead += cacheRead;
      current.requests += 1;
      byModel.set(model, current);

      if (row.session_id !== rootId) {
        subagentRequests += 1;
      }
    }
  }

  return {
    provider: 'opencode',
    perModel: [...byModel.values()],
    subagentRequests,
    skipped: { synthetic: 0, duplicates: 0 },
  };
}

/**
 * أبناء الجلسة تنازلياً. جلسات الوكلاء الفرعيين لدى opencode صفوف مستقلّة
 * يربطها `parent_id`، فإغفالها يُسقط عملهم من الفاتورة كما يُسقطه إغفال مجلّد
 * `subagents/` لدى كلود.
 */
function collectOpenCodeSessionTree(db: Database.Database, rootId: string): string[] {
  const children = db.prepare<[string], { id: string }>('SELECT id FROM session WHERE parent_id = ?');
  const collected = [rootId];
  const seen = new Set([rootId]);

  for (let index = 0; index < collected.length; index += 1) {
    for (const child of children.all(collected[index])) {
      if (!seen.has(child.id)) {
        seen.add(child.id);
        collected.push(child.id);
      }
    }
  }

  return collected;
}

/** استهلاك محادثة opencode واحدة (ومعها وكلاؤها الفرعيون). */
export function extractOpenCodeSessionUsage(
  databasePath: string,
  sessionId: string,
  window?: UsageWindow,
): DbSessionUsageOutcome {
  const outcome = withReadOnlyDatabase(databasePath, (db): DbSessionUsageOutcome => {
    const row = db
      .prepare<[string], OpenCodeSessionRow>(
        'SELECT id, parent_id, model, time_updated FROM session WHERE id = ?',
      )
      .get(sessionId);

    if (!row) {
      return {
        available: false,
        reason: 'This conversation is no longer in the OpenCode database, so its cost cannot be measured.',
      };
    }

    const tree = collectOpenCodeSessionTree(db, row.id);
    return {
      available: true,
      usage: accumulateOpenCodeMessages(db, tree, row.id, openCodeSessionModel(row.model), window),
    };
  });

  return outcome ?? { available: false, reason: missingDatabaseReason('OpenCode', databasePath) };
}

/**
 * كل محادثات opencode المساهمة داخل النافذة.
 *
 * المسح يبدأ من الجلسات الجذرية وحدها (`parent_id IS NULL`) لأن الأبناء
 * يُحتسبون تحت آبائهم — عدّهم مرّتين يضاعف فاتورة الوكلاء. والجلسة التي لم
 * تُلمَس منذ بداية الدورة (`time_updated < since`) لا تُفتح رسائلها أصلاً:
 * لا رسالة فيها يمكن أن تحمل طابعاً داخل النافذة، وهي نفس قفزة `stat` في
 * مسار كلود.
 *
 * ويشمل المسح محادثات أُنشئت خارج نسّاج (‏TUI) ما دامت في نفس القاعدة —
 * وهذا صواب لا تسامح: مجموع الدورة مجموع ما استُهلك على ذلك الاعتماد.
 */
export function collectOpenCodeCycleUsage(databasePath: string, window: UsageWindow): DbCycleUsageOutcome {
  const outcome = withReadOnlyDatabase(databasePath, (db): DbCycleUsageOutcome => {
    const roots = db
      .prepare<[], OpenCodeSessionRow>(
        'SELECT id, parent_id, model, time_updated FROM session WHERE parent_id IS NULL',
      )
      .all();

    const sessions: SessionUsage[] = [];
    for (const root of roots) {
      if (window.since !== undefined && readNumber(root.time_updated) < window.since) {
        continue;
      }
      const tree = collectOpenCodeSessionTree(db, root.id);
      const usage = accumulateOpenCodeMessages(db, tree, root.id, openCodeSessionModel(root.model), window);
      if (usage.perModel.length > 0) {
        sessions.push(usage);
      }
    }

    return { available: true, sessions };
  });

  return outcome ?? { available: false, reason: missingDatabaseReason('OpenCode', databasePath) };
}

// ---------------------------------------------------------------------------
// Hermes
// ---------------------------------------------------------------------------

type HermesSessionRow = {
  id: string;
  model: string | null;
  started_at: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
};

/**
 * كل جلسات Hermes التي بدأت داخل النافذة.
 *
 * `started_at` بالثواني العشرية (لا ملّي ثانية) — وهي **لحظة النسبة الوحيدة
 * المتاحة**: `ended_at` فارغ في كل صفّ مقيس، وعدّادات الرسائل لا تفصل مدخلاً
 * عن مخرج. الخشونة معلنة في رأس الملف وفي تقرير الميزة.
 *
 * ‏`reasoning_tokens` **لا يُضاف** إلى المخرجات: مصدره لدى Hermes نفسه
 * `output_tokens_details.reasoning_tokens` وهو جزءٌ منها بدلالة OpenAI.
 */
export function collectHermesCycleUsage(databasePath: string, window: UsageWindow): DbCycleUsageOutcome {
  const outcome = withReadOnlyDatabase(databasePath, (db): DbCycleUsageOutcome => {
    const rows = db
      .prepare<[], HermesSessionRow>(
        `SELECT id, model, started_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens
           FROM sessions`,
      )
      .all();

    const sessions: SessionUsage[] = [];
    for (const row of rows) {
      if (!withinWindow(readNumber(row.started_at) * 1000, window)) {
        continue;
      }

      const totals = emptyTotals();
      totals.input = readNumber(row.input_tokens);
      totals.output = readNumber(row.output_tokens);
      totals.cacheRead = readNumber(row.cache_read_tokens);
      totals.cacheWrite5m = readNumber(row.cache_write_tokens);

      const consumed =
        totals.input + totals.output + totals.cacheRead + totals.cacheWrite5m;
      const model = (row.model ?? '').trim();
      if (consumed === 0 || !model) {
        continue; // جلسة بلا استهلاك أو بلا نموذج: لا رقم يُنسب ولا اسم يُعرض.
      }

      sessions.push({
        provider: 'hermes',
        // طلب واحد لكل جلسة: القاعدة لا تحفظ عدد نداءات الـAPI مفصّلاً بعدّاداتها.
        perModel: [{ model, totals, requests: 1 }],
        subagentRequests: 0,
        skipped: { synthetic: 0, duplicates: 0 },
      });
    }

    return { available: true, sessions };
  });

  return outcome ?? { available: false, reason: missingDatabaseReason('Hermes', databasePath) };
}
