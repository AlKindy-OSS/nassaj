/**
 * سجلّ كلفة المشروع الدائم — الماسح (ADR-078).
 *
 * **العطب الذي وُجدت هذه الخدمة لأجله، مقيساً لا مفترَضاً:** لوحة الاشتراكات
 * كانت تعرض ‏6,712.40$ للدورة الجارية بينما القياس على السجلّات نفسها بنفس
 * محرّك التسعير يعطي ‏21,347.25$ — بخسٌ ‏3.2×. السبب أن المجموع كان يمشي على
 * `sessions` في قاعدة نسّاج (‏164 صفّاً) لا على السجلّات على القرص (‏432 سجلّاً
 * أسهم في الدورة). ما لم يُفهرَس قط كان يغيب صامتاً، والرقم يبدو نهائياً.
 *
 * ولذلك القاعدة الأولى هنا: **المشي على القرص لا على جدول الجلسات**.
 *
 * والقاعدة الثانية: **الكلفة تبقى بعد أن يختفي مصدرها**. كلود يكنس سجلّاته بعد
 * ~30 يوماً، فالحساب اللحظي من القرص يمحو تاريخ الإنفاق مع الملفات. الصفوف
 * تُكتب في `project_cost_daily` وتبقى؛ ولا سطر في هذا الملف يحذف صفّاً لأن
 * ملفه اختفى.
 *
 * والقاعدة الثالثة: **النسبة إلى اليوم بطابع الرسالة لا بتاريخ الملف**.
 * محادثة تمتدّ ثلاثة أيام تُنتج ثلاثة صفوف. الطابع الحقيقي هو الوحيد الذي
 * يجعل «كلفة يوم الثلاثاء» جملةً صادقة.
 *
 * وأخطر خاصّية في الميزة كلّها: **إعادة المسح لا تُضاعف**. الكتابة استبدالٌ
 * لصفوف المصدر بقيمتها المُعاد حسابها (`projectCostLedgerDb.replaceSource`)،
 * ولا وجود لـ`cost = cost + x` في أي مسار — جمعٌ تراكمي هنا يعني تضخّماً مع
 * كل نبضة مسح، وهو عطب يُصدَّق قبل أن يُكتشف.
 *
 * القياس والتسعير كلاهما مُعاد استعماله كما هو: `usage-extractors` (بقواعد
 * إزالة التكرار وأخذ أكبر مخرجات، ‏B-279) و`cost-calculator` و`model-vendor`.
 * لا قاعدة قراءة جديدة في هذا الملف.
 */

import Database from 'better-sqlite3';
import { createReadStream } from 'node:fs';
import { readdir, realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createInterface } from 'node:readline';

import { projectCostLedgerDb, projectsDb, sessionsDb, userDb } from '@/modules/database/index.js';
import type { LedgerDailyRow, LedgerRowInput, ProjectScope } from '@/modules/database/index.js';
import { resolveOpenCodeDataHomes } from '@/modules/providers/list/opencode/opencode-home.js';
import { resolveCodexHomes } from '@/modules/providers/list/codex/codex-home.js';
import { resolveProviderEnv } from '@/services/isolation/resolve-provider-env.js';
import { normalizeProjectPath, readOptionalString } from '@/shared/utils.js';

import { calculateSessionCost, type SessionCost } from './cost-calculator.js';
import { extractOpenCodeSessionUsage } from './db-usage-extractors.js';
import { PRICES_AS_OF } from './model-pricing.js';
import { resolveModelVendor, vendorDisplayName } from './model-vendor.js';
import {
  ClaudeUsageAccumulator,
  extractCodexSessionUsage,
  type SessionUsage,
  type UsageWindow,
} from './usage-extractors.js';

// ---------------------------------------------------------------------------
// العقد
// ---------------------------------------------------------------------------

export type LedgerScanOptions = {
  /** يتجاهل العلامات المائية فيُعاد قراءة كل شيء (تشخيص / تصحيح أسعار). */
  force?: boolean;
  /** الأجسام المطلوب مسحها. الافتراضي: كل ما يقبل النسبة إلى مشروع ويوم. */
  harnesses?: LedgerHarness[];
  /** جذور اختبارية تُحقن بدل جذور الجهاز. */
  claudeRoots?: string[];
  codexHomes?: string[];
  openCodeDatabases?: string[];
};

export type LedgerHarness = 'claude' | 'codex' | 'opencode';

/** ما لا يُنسب إلى مشروع أصلاً — يُقال ولا يُخمَّن (ADR-078). */
export type LedgerGap = { harness: string; reason: string };

export type LedgerScanReport = {
  /** سجلّات قُرئت فعلاً في هذا المسح. */
  scanned: number;
  /** سجلّات لم تتغيّر منذ آخر مسح فلم تُفتح. */
  skippedUnchanged: number;
  /** سجلّات لا يمكن نسبتها إلى مشروع (لا `cwd` ولا صفّ جلسة) — لم تُكتب. */
  unattributed: number;
  /** صفوف (مشروع، يوم، نموذج) كُتبت. */
  rowsWritten: number;
  /** أسطر استهلاك بلا طابع زمني صالح — لا تُنسب إلى يوم فتُستبعد، ويُقال كم. */
  undatedEntries: number;
  /** أخطاء لكل سجلّ، لا تُسقط المسح كلّه. */
  errors: string[];
  perHarness: Record<string, { scanned: number; skipped: number; rows: number }>;
  /** مصادر إنفاق معروفة لا تُنسب إلى مشروع — نقصٌ معلَن لا مسكوت عنه. */
  gaps: LedgerGap[];
  startedAt: string;
  finishedAt: string;
};

/**
 * مدى قراءة. يقبل يوماً نصّياً (‏YYYY-MM-DD) **أو** طابعاً بالملّي ثانية —
 * المسار يمرّر ‏epoch ms قادماً من `?since=`، والسجلّ مفهرَس باليوم المحلّي،
 * فالتحويل يقع هنا مرّةً بدل أن يُعاد في كل مستدعٍ. الحدّان **شاملان**:
 * `until` يقع داخل يومه لا قبله.
 */
export type LedgerRange = { since?: number | string; until?: number | string };

export type ProjectLedgerTotal = {
  projectId: string;
  projectPath: string | null;
  totalUsd: number;
  /**
   * `false` = لم يُمسح هذا المشروع بعد، فالصفر غياب قياس لا غياب إنفاق.
   * تُميّزه الواجهة نصّاً بدل أن تعرض «$0.00» عن مشروع لم يُقَس قط.
   */
  measured: boolean;
  /** false ⇒ الرقم جزئي: نموذج بلا سعر رسمي أو بسعر مفترَض أسهم فيه. */
  complete: boolean;
  unpricedModels: string[];
  assumedModels: string[];
  requests: number;
  conversations: number;
  /** نفس `conversations` باسم الجلسات — يقرؤه مسار الإحصاءات بهذا الاسم. */
  sessions: number;
  activeDays: number;
  firstDay: string | null;
  lastDay: string | null;
  pricesAsOf: string;
};

export type ProjectLedgerBreakdownRow = {
  /** المورّد أو النموذج بحسب القائمة. */
  key: string;
  displayName: string;
  vendor: string;
  /**
   * اسم النموذج في صفوف `byModel` (‏فارغ في صفوف `byVendor`). موجود لأن قارئ
   * صفوف النماذج يتعرّف عليها بحقل `model` ويُسقط ما لا يحمله.
   */
  model: string;
  harness: string;
  totalUsd: number;
  requests: number;
  conversations: number;
  complete: boolean;
};

export type ProjectLedgerStats = {
  projectId: string;
  projectPath: string | null;
  total: ProjectLedgerTotal;
  firstActivity: string | null;
  lastActivity: string | null;
  activeDays: number;
  conversations: number;
  byVendor: ProjectLedgerBreakdownRow[];
  byModel: ProjectLedgerBreakdownRow[];
  /** ما لم يدخل هذا الإجمالي أصلاً — يُعرض بجانبه لا يُطوى تحته. */
  gaps: LedgerGap[];
};

// ---------------------------------------------------------------------------
// ما لا يُنسب إلى مشروع — يُعلَن، ولا يُقدَّر
// ---------------------------------------------------------------------------

/**
 * ‏Hermes خارج السجلّ لسببٍ بنيوي لا كسل: نسّاج يولّد مُعرِّف المحادثة بنفسه
 * لأن `hermes -z` لا يُعيد مُعرِّفه الداخلي، و`state.db` ترقّم جلساتها بترقيم
 * آخر — فلا مفتاح وصل، ولا حقل مجلَّد عمل في صفوفها أصلاً. نسبة إنفاقه إلى
 * مشروع ستكون تخميناً يُعرض كقياس.
 *
 * والمزوّدات التي لا تكتب عدّاداً أصلاً (‏agy/antigravity، cursor) لا شيء
 * لنسبته من الأساس.
 */
const KNOWN_GAPS: readonly LedgerGap[] = Object.freeze([
  Object.freeze({
    harness: 'hermes',
    reason:
      'Hermes records its token counts in ~/.hermes/state.db with no working-directory field and no id nassaj can match, so its spend cannot be attributed to a project or a day.',
  }),
  Object.freeze({
    harness: 'antigravity',
    reason: 'Antigravity (agy) records no token counts at all, so there is nothing to attribute.',
  }),
  Object.freeze({
    harness: 'cursor',
    reason: 'Cursor does not expose token usage in its CLI transcripts.',
  }),
]) as readonly LedgerGap[];

const DEFAULT_HARNESSES: LedgerHarness[] = ['claude', 'codex', 'opencode'];

// ---------------------------------------------------------------------------
// اليوم المحلّي
// ---------------------------------------------------------------------------

const pad2 = (value: number): string => String(value).padStart(2, '0');

/**
 * اليوم بالتوقيت **المحلّي للخادم** لا UTC: «كلفة أمس» جملةٌ يقولها المالك عن
 * يومه هو. والثبات مضمون ما دام الخادم على منطقةٍ واحدة — وتغييرها يزيح حدود
 * الأيام القديمة، وهو ثمن مقبول مقابل أيامٍ تطابق ما يراه الإنسان.
 */
export const localDay = (epochMs: number): string => {
  const date = new Date(epochMs);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
};

/** حدود اليوم المحلّي: ‏[بداية، بداية اليوم التالي). يعبر التوقيت الصيفي سليماً. */
export const dayBounds = (day: string): UsageWindow => {
  const [year, month, date] = day.split('-').map((part) => Number(part));
  const start = new Date(year, (month ?? 1) - 1, date ?? 1, 0, 0, 0, 0);
  const end = new Date(year, (month ?? 1) - 1, (date ?? 1) + 1, 0, 0, 0, 0);
  return { since: start.getTime(), until: end.getTime() };
};

const parseTimestampMs = (value: unknown): number => {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  const parsed = typeof value === 'string' ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.NaN;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

// ---------------------------------------------------------------------------
// نسبة السجلّ إلى مشروع
// ---------------------------------------------------------------------------

/**
 * مشروعٌ لم يُسجَّل في `projects` بعد يأخذ مُعرِّفاً اصطناعياً من مساره بدل
 * أن يسقط من السجلّ. البادئة تجعل الأصل ظاهراً، ويوم يُسجَّل المشروع رسمياً
 * يبقى تاريخه موصولاً عبر `project_path` (‏جسر المسار في المستودع).
 */
export const PATH_PROJECT_ID_PREFIX = 'path:';

type ProjectRef = { projectId: string; projectPath: string };

const projectRefCache = new Map<string, ProjectRef>();

function resolveProjectRef(rawPath: string): ProjectRef | null {
  const normalized = normalizeProjectPath(rawPath);
  if (!normalized) {
    return null;
  }

  const cached = projectRefCache.get(normalized);
  if (cached) {
    return cached;
  }

  let projectId = `${PATH_PROJECT_ID_PREFIX}${normalized}`;
  try {
    const row = projectsDb.getProjectPath(normalized);
    if (row?.project_id) {
      projectId = row.project_id;
    }
  } catch {
    // قاعدة غير مهيّأة (اختبار/إقلاع مبكر) — المُعرِّف من المسار يكفي.
  }

  const ref: ProjectRef = { projectId, projectPath: normalized };
  projectRefCache.set(normalized, ref);
  return ref;
}

/** نطاق القراءة لمُعرِّف مشروع: المسار جسرٌ لتاريخٍ سُجّل تحت مُعرِّف سابق. */
function resolveScope(projectId: string): ProjectScope {
  if (projectId.startsWith(PATH_PROJECT_ID_PREFIX)) {
    return { projectId, projectPath: projectId.slice(PATH_PROJECT_ID_PREFIX.length) || null };
  }
  try {
    return { projectId, projectPath: projectsDb.getProjectPathById(projectId) };
  } catch {
    return { projectId, projectPath: null };
  }
}

// ---------------------------------------------------------------------------
// من الكلفة إلى صفوف السجلّ
// ---------------------------------------------------------------------------

/**
 * يحوّل كلفة يومٍ واحد إلى صفوف. `costUsd === null` تعني **لا سعر رسمي** لا
 * صفر إنفاق: يُكتب الصفّ بـ`priced=0` فيبقى الاستهلاك مسجَّلاً ويُعرَض
 * الإجمالي جزئياً — الطمس هنا هو ما تمنعه قاعدة الصدق.
 */
function costToRows(ref: ProjectRef, day: string, harness: string, cost: SessionCost): LedgerRowInput[] {
  const rows: LedgerRowInput[] = [];

  for (const entry of cost.perModel) {
    const hasUsage =
      entry.tokens.input + entry.tokens.output + entry.tokens.cacheWrite5m + entry.tokens.cacheWrite1h + entry.tokens.cacheRead > 0;
    if (!hasUsage && entry.requests === 0) {
      continue;
    }

    rows.push({
      projectId: ref.projectId,
      projectPath: ref.projectPath,
      day,
      vendor: resolveModelVendor(entry.model, harness),
      model: entry.model,
      harness,
      costUsd: entry.costUsd ?? 0,
      priced: entry.costUsd !== null,
      assumed: cost.assumedModels?.includes(entry.model) === true,
      tokens: { ...entry.tokens },
      requests: entry.requests,
      pricesAsOf: cost.pricesAsOf,
    });
  }

  return rows;
}

// ---------------------------------------------------------------------------
// الجذور على القرص
// ---------------------------------------------------------------------------

/**
 * جذور مشاريع كلود: جذر المشغّل **وكل جذر مستخدم معزول**. الاثنان يلتقيان
 * عملياً على هذا التثبيت (‏provisionUserDirs يربط `projects/` رمزياً إلى جذر
 * المشغّل) — ولذلك يُفكّ الرابط بـ`realpath` قبل إزالة التكرار: بدونها يُمسح
 * نفس الملف مرّةً لكل مستخدم، وبمفاتيح مصادر مختلفة، فيتضاعف الإجمالي.
 */
async function resolveClaudeProjectRoots(): Promise<string[]> {
  const candidates = new Set<string>([path.join(os.homedir(), '.claude', 'projects')]);

  try {
    for (const user of userDb.listUsers()) {
      try {
        const env = resolveProviderEnv(user.id, 'claude', process.env);
        const configDir = readOptionalString(env.CLAUDE_CONFIG_DIR);
        if (configDir) {
          candidates.add(path.join(configDir, 'projects'));
        }
      } catch {
        // فشل حلّ بيئة مستخدم واحد لا يمنع مسح البقيّة.
      }
    }
  } catch {
    // تعذّر تعداد المستخدمين ⇒ جذر المشغّل وحده (تدهور لا سقوط).
  }

  return dedupeByRealPath([...candidates]);
}

/** يُزيل تكرار المسارات بعد فكّ الروابط الرمزية. غير الموجود يُسقَط. */
async function dedupeByRealPath(candidates: string[]): Promise<string[]> {
  const seen = new Set<string>();
  const resolved: string[] = [];

  for (const candidate of candidates) {
    try {
      const real = await realpath(candidate);
      if (!seen.has(real)) {
        seen.add(real);
        resolved.push(real);
      }
    } catch {
      // مسار غير موجود — لا سجلّات فيه.
    }
  }

  return resolved;
}

/** كل ملفات JSONL تحت مجلّد، تنازلياً. */
async function collectJsonlFiles(directory: string): Promise<string[]> {
  const collected: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
      } else if (entry.isFile() && entry.name.endsWith('.jsonl')) {
        collected.push(full);
      }
    }
  };

  await walk(directory);
  return collected;
}

type FileSignature = { mtimeMs: number; size: number };

async function signatureOf(files: string[]): Promise<FileSignature> {
  let mtimeMs = 0;
  let size = 0;
  for (const file of files) {
    try {
      const info = await stat(file);
      mtimeMs = Math.max(mtimeMs, info.mtimeMs);
      size += info.size;
    } catch {
      // ملف اختفى أثناء المشي — يُتجاهل، ولا يُحذف شيء من السجلّ بسببه.
    }
  }
  // التقريب هنا لا عند المقارنة: العلامة المائية تُخزَّن صحيحةً، فبقاء الكسر
  // في البصمة يجعل كل ملف «أحدث من علامته» دائماً فيُعاد مسح كل شيء أبداً.
  return { mtimeMs: Math.round(mtimeMs), size };
}

/** يقرأ ملف JSONL سطراً سطراً (بعض السجلّات تتجاوز 100MB فلا readFile). */
async function forEachJsonlEntry(filePath: string, visit: (entry: unknown) => void): Promise<void> {
  try {
    await stat(filePath);
  } catch {
    // اختفى بين المشي والقراءة (كنس جارٍ) — لا يُسقط بقيّة المحادثة.
    return;
  }

  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123 /* '{' */) {
        continue;
      }
      try {
        visit(JSON.parse(line));
      } catch {
        // سطر مقطوع (كتابة جارية) — يُتخطّى ولا يُسقط الملف كلّه.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

// ---------------------------------------------------------------------------
// كلود
// ---------------------------------------------------------------------------

type TranscriptScan = {
  rows: LedgerRowInput[];
  undatedEntries: number;
  attributed: boolean;
};

/**
 * سجلّ كلود واحد: ملف الأمّ + كل ملفات الوكلاء الفرعيين تحت مجلّده.
 *
 * **قراءة واحدة تُنتج كل الأيام.** كل سطر يُوجَّه إلى مُجمِّع يومه بطابعه هو،
 * وهذا مكافئ تماماً لاستدعاء المُستخرِج بنافذة لكل يوم (‏`withinWindow` يرشّح
 * بنفس الطابع) لكنه يقرأ الملف مرّة لا مرّةً لكل يوم — والملفات هنا تبلغ مئات
 * الميغابايت.
 *
 * حدّ معروف ومقبول: مجموعة أسطر مكرَّرة لردٍّ واحد تقع على جانبَي منتصف الليل
 * تُحتسب في اليومين. الأسطر المكرَّرة تُكتب في نفس الملّي ثانية عملياً،
 * فالاحتمال نظري — والبديل (نافذة لكل يوم) يحمل نفس الحدّ حرفياً.
 */
async function scanClaudeTranscript(files: string[], sessionIdHint?: string): Promise<TranscriptScan> {
  const byDay = new Map<string, ClaudeUsageAccumulator>();
  let projectPath = '';
  let undatedEntries = 0;

  for (const file of files) {
    // ملف اختفى بين المشي والقراءة (كنس جارٍ) لا يُسقط بقيّة المحادثة.
    await forEachJsonlEntry(file, (entry) => {
      if (!isRecord(entry)) {
        return;
      }
      if (!projectPath && typeof entry.cwd === 'string' && entry.cwd.trim()) {
        projectPath = entry.cwd.trim();
      }
      if (entry.type !== 'assistant') {
        return;
      }

      const timestamp = parseTimestampMs(entry.timestamp);
      if (!Number.isFinite(timestamp)) {
        // بلا طابع لا يوجد يوم يُنسب إليه. حشرُه في «اليوم» يفبرك تاريخاً،
        // فيُستبعَد ويُعلَن عدده في التقرير.
        undatedEntries += 1;
        return;
      }

      const day = localDay(timestamp);
      let accumulator = byDay.get(day);
      if (!accumulator) {
        accumulator = new ClaudeUsageAccumulator();
        byDay.set(day, accumulator);
      }
      accumulator.addEntry(entry);
    });
  }

  // احتياط النسبة: صفّ الجلسة في قاعدة نسّاج حين لا `cwd` في السجلّ نفسه.
  if (!projectPath && sessionIdHint) {
    try {
      projectPath = sessionsDb.getSessionById(sessionIdHint)?.project_path ?? '';
    } catch {
      // لا صفّ — يبقى غير منسوب.
    }
  }

  const ref = projectPath ? resolveProjectRef(projectPath) : null;
  if (!ref) {
    return { rows: [], undatedEntries, attributed: false };
  }

  const rows: LedgerRowInput[] = [];
  for (const [day, accumulator] of byDay) {
    rows.push(...costToRows(ref, day, 'claude', calculateSessionCost(accumulator.result('claude'))));
  }

  return { rows, undatedEntries, attributed: true };
}

// ---------------------------------------------------------------------------
// كودكس
// ---------------------------------------------------------------------------

/**
 * سجلّ كودكس واحد. عدّاده **تراكمي**، فحصّة اليوم طرحٌ من آخر عدّاد قبله —
 * وهو ما يفعله `extractCodexSessionUsage` بالضبط حين يُعطى نافذة. لذلك
 * تُجمَع الأيام أوّلاً بقراءة خفيفة (طوابع أحداث `token_count` وحدها) ثم
 * يُستدعى المُستخرِج مرّة لكل يوم: ملفات الـrollout صغيرة، وإعادة تنفيذ منطق
 * الطرح هنا كانت ستنسخ أدقّ قاعدة في المُستخرِج.
 */
async function scanCodexRollout(rolloutPath: string): Promise<TranscriptScan> {
  const days = new Set<string>();
  let projectPath = '';
  let undatedEntries = 0;

  await forEachJsonlEntry(rolloutPath, (entry) => {
    if (!isRecord(entry)) {
      return;
    }
    const payload = isRecord(entry.payload) ? entry.payload : null;
    if (!payload) {
      return;
    }
    if (!projectPath && typeof payload.cwd === 'string' && payload.cwd.trim()) {
      projectPath = payload.cwd.trim();
    }
    if (payload.type !== 'token_count') {
      return;
    }

    const timestamp = parseTimestampMs(entry.timestamp);
    if (!Number.isFinite(timestamp)) {
      undatedEntries += 1;
      return;
    }
    days.add(localDay(timestamp));
  });

  const ref = projectPath ? resolveProjectRef(projectPath) : null;
  if (!ref) {
    return { rows: [], undatedEntries, attributed: false };
  }

  const rows: LedgerRowInput[] = [];
  for (const day of days) {
    const usage = await extractCodexSessionUsage(rolloutPath, dayBounds(day));
    rows.push(...costToRows(ref, day, 'codex', calculateSessionCost(usage)));
  }

  return { rows, undatedEntries, attributed: true };
}

// ---------------------------------------------------------------------------
// opencode
// ---------------------------------------------------------------------------

type OpenCodeRoot = { id: string; directory: string | null; timeUpdated: number };

/**
 * أيام محادثة opencode تُقرأ من طوابع رسائلها هي (وشجرة وكلائها)، لا من مدى
 * الجلسة: جلسة فُتحت في يناير وأُكملت في مارس ليس لها إنفاق في كل ما بينهما،
 * ومسحُ المدى كاملاً استعلامٌ لكل يوم فارغ.
 *
 * القراءة **للقراءة فقط ودون إنشاء**؛ وقاعدة غائبة أو بجدول مختلف تعود بلا
 * شيء لا باستثناء — أداةٌ خارجية لا يجوز أن تُسقط مسح نسّاج.
 */
function readOpenCodeRoots(databasePath: string): { roots: OpenCodeRoot[]; daysBySession: Map<string, string[]> } {
  const empty = { roots: [] as OpenCodeRoot[], daysBySession: new Map<string, string[]>() };
  let db: Database.Database | null = null;

  try {
    db = new Database(databasePath, { readonly: true, fileMustExist: true });
    const roots = db
      .prepare('SELECT id, directory, time_updated FROM session WHERE parent_id IS NULL')
      .all() as { id: string; directory: string | null; time_updated: number }[];

    const daysStatement = db.prepare(
      `WITH RECURSIVE tree(id) AS (
         SELECT ?
         UNION
         SELECT session.id FROM session JOIN tree ON session.parent_id = tree.id
       )
       SELECT time_created FROM message WHERE session_id IN (SELECT id FROM tree)`
    );

    const daysBySession = new Map<string, string[]>();
    for (const root of roots) {
      const stamps = daysStatement.all(root.id) as { time_created: number }[];
      const days = new Set<string>();
      for (const stamp of stamps) {
        const timestamp = parseTimestampMs(stamp.time_created);
        if (Number.isFinite(timestamp)) {
          days.add(localDay(timestamp));
        }
      }
      daysBySession.set(root.id, [...days]);
    }

    return {
      roots: roots.map((row) => ({
        id: row.id,
        directory: row.directory,
        timeUpdated: Number(row.time_updated) || 0,
      })),
      daysBySession,
    };
  } catch {
    return empty;
  } finally {
    db?.close();
  }
}

// ---------------------------------------------------------------------------
// الماسح
// ---------------------------------------------------------------------------

const emptyHarnessStat = () => ({ scanned: 0, skipped: 0, rows: 0 });

/**
 * قفل مسحٍ واحد: نبضتان متزامنتان تقرآن نفس الملفات وتكتبان نفس الصفوف —
 * الاستبدال يجعل النتيجة صحيحة على أي حال، لكن العمل يتضاعف بلا فائدة.
 */
let inFlightScan: Promise<LedgerScanReport> | null = null;

async function runScan(options: LedgerScanOptions): Promise<LedgerScanReport> {
  const startedAt = new Date().toISOString();
  const harnesses = options.harnesses ?? DEFAULT_HARNESSES;
  const report: LedgerScanReport = {
    scanned: 0,
    skippedUnchanged: 0,
    unattributed: 0,
    rowsWritten: 0,
    undatedEntries: 0,
    errors: [],
    perHarness: {},
    gaps: [...KNOWN_GAPS],
    startedAt,
    finishedAt: startedAt,
  };

  // مسارات المشاريع تتغيّر نادراً، والكاش يعيش عمر المسح وحده كي لا يتجمّد
  // مُعرِّف مشروع سُجّل بين مسحين.
  projectRefCache.clear();

  const persist = (
    harness: string,
    sourceKey: string,
    provider: string,
    signature: FileSignature,
    scan: TranscriptScan,
  ): void => {
    const stats = (report.perHarness[harness] ??= emptyHarnessStat());
    report.undatedEntries += scan.undatedEntries;

    if (!scan.attributed) {
      // بلا مشروع لا مكان للصفّ. **ولا تُكتب علامة مائية** كي يُعاد النظر
      // فيه حين يُسجَّل مشروعه لاحقاً — تخطّيه للأبد يُخفيه بلا أثر.
      report.unattributed += 1;
      return;
    }

    projectCostLedgerDb.replaceSource(
      { sourceKey, provider, mtimeMs: signature.mtimeMs, sizeBytes: signature.size },
      scan.rows,
    );
    report.rowsWritten += scan.rows.length;
    stats.rows += scan.rows.length;
  };

  // --- كلود -----------------------------------------------------------------
  if (harnesses.includes('claude')) {
    const stats = (report.perHarness.claude ??= emptyHarnessStat());
    const watermarks = projectCostLedgerDb.getSourceWatermarks('claude');
    const roots = options.claudeRoots ? await dedupeByRealPath(options.claudeRoots) : await resolveClaudeProjectRoots();

    for (const root of roots) {
      let projectDirs;
      try {
        projectDirs = await readdir(root, { withFileTypes: true });
      } catch {
        continue;
      }

      for (const projectDir of projectDirs) {
        if (!projectDir.isDirectory()) {
          continue;
        }
        const directory = path.join(root, projectDir.name);
        let entries;
        try {
          entries = await readdir(directory, { withFileTypes: true });
        } catch {
          continue;
        }

        const transcriptNames = new Set(
          entries.filter((entry) => entry.isFile() && entry.name.endsWith('.jsonl')).map((entry) => entry.name),
        );

        for (const entry of entries) {
          // مجلّد جلسة **يتيم**: بقي وكلاؤه الفرعيون بعد أن كنس كلود ملف الأمّ.
          // بلا هذا الفرع يسقط عملهم كلّه من الفاتورة بلا أثر — وهو نفس نوع
          // الغياب الصامت الذي وُجدت الميزة لمنعه (مقيس على هذا الجهاز: مجلّد
          // واحد بسبعة سجلّات وكلاء بلا أمّ).
          if (entry.isDirectory() && !transcriptNames.has(`${entry.name}.jsonl`)) {
            const orphanDirectory = path.join(directory, entry.name);
            try {
              const orphanFiles = await collectJsonlFiles(orphanDirectory);
              if (orphanFiles.length === 0) {
                continue; // مجلّد خدمي (‏memory/ وأمثاله) لا سجلّات فيه.
              }

              // **قاعدة عدم الازدواج**: إن كنّا قد مسحنا ملف الأمّ يوماً، فصفوفه
              // في السجلّ **تحوي أصلاً** استهلاك هؤلاء الوكلاء (كانوا يُقرأون
              // ضمنها)، وتلك الصفوف باقية بحكم الديمومة — فابتلاع المجلّد الآن
              // كمصدر مستقلّ يحسب المبلغ مرّتين إلى الأبد.
              // ولذلك: يُبتلَع اليتيم **فقط** حين لا علامة مائية للأمّ، أي حين
              // لم نره قطّ (تثبيت جديد، أو كُنِس قبل أوّل مسح) فيكون المجلّد
              // هو السجلّ الوحيد لذلك الإنفاق.
              const parentSourceKey = path.join(directory, `${entry.name}.jsonl`);
              if (watermarks.has(parentSourceKey)) {
                report.skippedUnchanged += 1;
                stats.skipped += 1;
                continue;
              }
              const signature = await signatureOf(orphanFiles);
              const known = watermarks.get(orphanDirectory);
              if (!options.force && known && known.mtimeMs >= signature.mtimeMs && known.sizeBytes === signature.size) {
                report.skippedUnchanged += 1;
                stats.skipped += 1;
                continue;
              }
              const scan = await scanClaudeTranscript(orphanFiles, entry.name);
              report.scanned += 1;
              stats.scanned += 1;
              persist('claude', orphanDirectory, 'claude', signature, scan);
            } catch (error) {
              report.errors.push(`claude:${orphanDirectory}: ${error instanceof Error ? error.message : String(error)}`);
            }
            continue;
          }

          // ملفات الجلسات في جذر مجلّد المشروع؛ وبقيّة المجلّدات مجلّدات وكلاء
          // فرعيين تُقرأ ضمن محادثتها الأمّ لا كمحادثات مستقلّة.
          if (!entry.isFile() || !entry.name.endsWith('.jsonl')) {
            continue;
          }

          const transcriptPath = path.join(directory, entry.name);
          const sessionId = entry.name.replace(/\.jsonl$/, '');

          try {
            const files = [transcriptPath, ...(await collectJsonlFiles(transcriptPath.replace(/\.jsonl$/, '')))];
            const signature = await signatureOf(files);
            const known = watermarks.get(transcriptPath);
            if (!options.force && known && known.mtimeMs >= signature.mtimeMs && known.sizeBytes === signature.size) {
              report.skippedUnchanged += 1;
              stats.skipped += 1;
              continue;
            }

            const scan = await scanClaudeTranscript(files, sessionId);
            report.scanned += 1;
            stats.scanned += 1;
            persist('claude', transcriptPath, 'claude', signature, scan);
          } catch (error) {
            report.errors.push(`claude:${transcriptPath}: ${error instanceof Error ? error.message : String(error)}`);
          }
        }
      }
    }
  }

  // --- كودكس ----------------------------------------------------------------
  if (harnesses.includes('codex')) {
    const stats = (report.perHarness.codex ??= emptyHarnessStat());
    const watermarks = projectCostLedgerDb.getSourceWatermarks('codex');
    const homes = options.codexHomes ? await dedupeByRealPath(options.codexHomes) : await dedupeByRealPath(resolveCodexHomes());

    for (const home of homes) {
      const rollouts = await collectJsonlFiles(path.join(home, 'sessions'));
      for (const rolloutPath of rollouts) {
        try {
          const signature = await signatureOf([rolloutPath]);
          const known = watermarks.get(rolloutPath);
          if (!options.force && known && known.mtimeMs >= signature.mtimeMs && known.sizeBytes === signature.size) {
            report.skippedUnchanged += 1;
            stats.skipped += 1;
            continue;
          }

          const scan = await scanCodexRollout(rolloutPath);
          report.scanned += 1;
          stats.scanned += 1;
          persist('codex', rolloutPath, 'codex', signature, scan);
        } catch (error) {
          report.errors.push(`codex:${rolloutPath}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  // --- opencode -------------------------------------------------------------
  if (harnesses.includes('opencode')) {
    const stats = (report.perHarness.opencode ??= emptyHarnessStat());
    const watermarks = projectCostLedgerDb.getSourceWatermarks('opencode');
    const databases = options.openCodeDatabases
      ? await dedupeByRealPath(options.openCodeDatabases)
      : await dedupeByRealPath(resolveOpenCodeDataHomes().map((home) => path.join(home, 'opencode.db')));

    for (const databasePath of databases) {
      const { roots, daysBySession } = readOpenCodeRoots(databasePath);

      for (const root of roots) {
        // المفتاح يحمل مسار القاعدة: نفس مُعرِّف الجلسة قد يتكرّر بين قاعدتَي
        // مستخدمين معزولين، وخلطهما يمحو إنفاق أحدهما بإنفاق الآخر.
        const sourceKey = `opencode:${databasePath}:${root.id}`;
        try {
          // بصمة الجلسة هي `time_updated` نفسه: القاعدة لا تُعطي mtime لكل
          // جلسة، وهذا الحقل هو ما يتحرّك مع كل رسالة جديدة.
          const signature: FileSignature = { mtimeMs: root.timeUpdated, size: 0 };
          const known = watermarks.get(sourceKey);
          if (!options.force && known && known.mtimeMs >= signature.mtimeMs) {
            report.skippedUnchanged += 1;
            stats.skipped += 1;
            continue;
          }

          const ref = root.directory ? resolveProjectRef(root.directory) : null;
          if (!ref) {
            report.scanned += 1;
            stats.scanned += 1;
            report.unattributed += 1;
            continue;
          }

          const rows: LedgerRowInput[] = [];
          for (const day of daysBySession.get(root.id) ?? []) {
            const outcome = extractOpenCodeSessionUsage(databasePath, root.id, dayBounds(day));
            if (!outcome.available) {
              continue;
            }
            rows.push(...costToRows(ref, day, 'opencode', calculateSessionCost(outcome.usage)));
          }

          report.scanned += 1;
          stats.scanned += 1;
          persist('opencode', sourceKey, 'opencode', signature, {
            rows,
            undatedEntries: 0,
            attributed: true,
          });
        } catch (error) {
          report.errors.push(`opencode:${sourceKey}: ${error instanceof Error ? error.message : String(error)}`);
        }
      }
    }
  }

  report.finishedAt = new Date().toISOString();
  return report;
}

// ---------------------------------------------------------------------------
// الخدمة
// ---------------------------------------------------------------------------

/** يحوّل حدّ المدى إلى يوم محلّي. الطابع بالملّي ثانية يصير يومه هو. */
const toDayBound = (value: number | string | undefined): string | undefined => {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (typeof value === 'number') {
    return Number.isFinite(value) ? localDay(value) : undefined;
  }
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    return trimmed;
  }
  const parsed = Number(trimmed);
  if (Number.isFinite(parsed)) {
    return localDay(parsed);
  }
  const asDate = Date.parse(trimmed);
  return Number.isFinite(asDate) ? localDay(asDate) : undefined;
};

const toDayRange = (range: LedgerRange): { since?: string; until?: string } => ({
  since: toDayBound(range.since),
  until: toDayBound(range.until),
});

const toTotal = (scope: ProjectScope, totals: ReturnType<typeof projectCostLedgerDb.getTotals>): ProjectLedgerTotal => ({
  projectId: scope.projectId,
  projectPath: scope.projectPath,
  totalUsd: totals.totalUsd,
  measured: totals.measured,
  complete: totals.complete,
  unpricedModels: totals.unpricedModels,
  assumedModels: totals.assumedModels,
  requests: totals.requests,
  conversations: totals.conversations,
  sessions: totals.conversations,
  activeDays: totals.days,
  firstDay: totals.firstDay,
  lastDay: totals.lastDay,
  // تاريخ الأسعار يُعرض مع كل مبلغ: الرقم مؤرَّخ لا مُطلَق (ADR-078 §3).
  pricesAsOf: totals.pricesAsOf ?? PRICES_AS_OF,
});

export const costLedgerService = {
  /**
   * يمسح السجلّات على القرص ويُحدِّث السجلّ الدائم.
   *
   * تزايدي بالعلامات المائية، وعديم الأثر بالتكرار بحكم `replaceSource`. مسحان
   * متتاليان بلا تغيّر على القرص يتركان كل رقم كما هو — وهذا مُختبَر لا مُدّعى.
   */
  async scan(options: LedgerScanOptions = {}): Promise<LedgerScanReport> {
    // مسحٌ جارٍ: الطلب العادي ينضمّ إليه (لا فائدة من قراءة القرص مرّتين معاً).
    // أمّا `force` فله معنى لا يؤدّيه المسح الجاري — إعادة قراءة ما تخطّته
    // العلامات المائية — فلو أعدنا له وعد المسح العادي لعاد بنتيجة ليست
    // التي طلبها، ويبدو أنّه أُجري وهو لم يُجرَ. فيُصطفّ بعده بدل أن يُبتلع.
    if (inFlightScan) {
      if (!options.force) {
        return inFlightScan;
      }
      const queued = inFlightScan
        .catch(() => undefined)
        .then(() => costLedgerService.scan(options));
      return queued;
    }
    inFlightScan = runScan(options).finally(() => {
      inFlightScan = null;
    });
    return inFlightScan;
  },

  /** إجمالي كلفة مشروع عبر كل تاريخه المسجَّل — ويبقى بعد حذف محادثاته. */
  getProjectTotal(projectId: string): ProjectLedgerTotal {
    const scope = resolveScope(projectId);
    return toTotal(scope, projectCostLedgerDb.getTotals(scope));
  },

  /** السلسلة اليومية (‏YYYY-MM-DD محلّي)، الأقدم أولاً. */
  getProjectDaily(projectId: string, range: LedgerRange = {}): LedgerDailyRow[] {
    return projectCostLedgerDb.getDaily(resolveScope(projectId), toDayRange(range));
  },

  /** كل ما تحتاجه صفحة إحصاءات المشروع في استدعاء واحد. */
  getProjectStats(projectId: string): ProjectLedgerStats {
    const scope = resolveScope(projectId);
    const totals = projectCostLedgerDb.getTotals(scope);
    const total = toTotal(scope, totals);

    const decorate = (rows: ReturnType<typeof projectCostLedgerDb.getVendorTotals>, isVendor: boolean) =>
      rows.map((row) => ({
        key: row.key,
        displayName: isVendor ? vendorDisplayName(row.vendor as never) : row.key,
        vendor: row.vendor,
        model: isVendor ? '' : row.key,
        harness: row.harness,
        totalUsd: row.totalUsd,
        requests: row.requests,
        conversations: row.conversations,
        complete: row.complete,
      }));

    return {
      projectId: scope.projectId,
      projectPath: scope.projectPath,
      total,
      firstActivity: totals.firstDay,
      lastActivity: totals.lastDay,
      activeDays: totals.days,
      conversations: totals.conversations,
      byVendor: decorate(projectCostLedgerDb.getVendorTotals(scope), true),
      byModel: decorate(projectCostLedgerDb.getModelTotals(scope), false),
      gaps: [...KNOWN_GAPS],
    };
  },

  /** المشاريع التي لها أثر في السجلّ — للوحة عامة أو تشخيص. */
  listProjects(): { projectId: string; projectPath: string | null; totalUsd: number }[] {
    return projectCostLedgerDb.listProjects();
  },

  /** خطّاف اختبار: يُفرِغ كاش نسبة المشاريع. ليس على مسار الطلب. */
  _resetCaches(): void {
    projectRefCache.clear();
  },
};

// ---------------------------------------------------------------------------
// المجدوِل: بلا نبضة تلقائية لا ديمومة أصلاً
// ---------------------------------------------------------------------------

/**
 * السجلّ يَعِد بأن يبقى المبلغ بعد كنس المحادثات. هذا الوعد يسقط كلّياً إن لم
 * يُمسح السجلّ إلّا حين يضغط مسؤولٌ زرّاً: المزوّد يكنس نسخته بعد ~30 يوماً،
 * فأي إنفاق لم يُبتلع قبل الكنس **لا مصدر له بعده** — لا نقصاً يُستدرك لاحقاً
 * بل فقداناً نهائياً صامتاً. لذلك النبضة جزء من الميزة لا تحسينٌ لها.
 *
 * الفترة خشنة (6 ساعات) عمداً، وهي أقصر من نافذة الكنس بمرتَبتين، والمسح
 * تزايديّ بالعلامات المائية (مقيس: 5.2ث بارداً مقابل 39مث دافئاً على 255
 * مصدراً) فالنبضة الدوريّة تكاد لا تُكلّف شيئاً.
 */
const LEDGER_SCAN_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** تأخير النبضة الأولى: الإقلاع أولى بالمعالج من مسح القرص. */
const LEDGER_BOOT_DELAY_MS = 30 * 1000;

let ledgerTimer: NodeJS.Timeout | null = null;
let ledgerBootTimer: NodeJS.Timeout | null = null;

function runScheduledScan(label: string): void {
  void costLedgerService
    .scan()
    .then((report) => {
      if (report.scanned > 0 || report.errors.length > 0) {
        console.log(
          `[cost-ledger] ${label}: scanned=${report.scanned} skipped=${report.skippedUnchanged}` +
            ` rows=${report.rowsWritten} errors=${report.errors.length}`,
        );
      }
    })
    .catch((err: unknown) => {
      // فشل المسح لا يُسقط الخادم أبداً: السجلّ رقمٌ إعلاميّ لا مسار طلب.
      console.error(`[cost-ledger] ${label} failed:`, err);
    });
}

/**
 * يبدأ النبض الدوري. يُستدعى من `server/index.js` بعد `initializeDatabase()`
 * — لا من داخل التهيئة نفسها، لأنها تُستدعى في كل اختبار فيصير كل اختبار
 * ماسحاً لقرص المطوّر.
 */
export function startCostLedgerScheduler(): void {
  stopCostLedgerScheduler();

  ledgerBootTimer = setTimeout(() => {
    runScheduledScan('boot pass');
  }, LEDGER_BOOT_DELAY_MS);
  ledgerBootTimer.unref();

  ledgerTimer = setInterval(() => {
    runScheduledScan('scheduled pass');
  }, LEDGER_SCAN_INTERVAL_MS);
  ledgerTimer.unref();
}

/** يوقف النبض — للاختبارات وللإغلاق الرشيد. */
export function stopCostLedgerScheduler(): void {
  if (ledgerBootTimer !== null) {
    clearTimeout(ledgerBootTimer);
    ledgerBootTimer = null;
  }
  if (ledgerTimer !== null) {
    clearInterval(ledgerTimer);
    ledgerTimer = null;
  }
}

export type { SessionUsage };
