/**
 * السجلّ الدائم لكلفة المشاريع (ADR-078) — طبقة التخزين وحدها.
 *
 * لا قياس ولا تسعير هنا: الخدمة (`cost-ledger.service`) تقرأ السجلّات من
 * القرص وتُسعّرها، وهذا الملف يكتب النتيجة ويقرأها مُجمَّعة.
 *
 * **القاعدة الأخطر في الميزة كلّها، ومكانها هنا:** الكتابة **استبدال لصفوف
 * المصدر** (‏حذف ثم إدراج داخل معاملة واحدة) ولا `cost = cost + x` في أي
 * سطر من هذا الملف. جمعٌ تراكمي يحوّل كل إعادة مسح إلى تضخيم صامت للفاتورة،
 * وهو عطبٌ لا يُكتشف إلا بعد أن يُصدَّق الرقم. المفتاح يحمل `source_key` كي
 * يبقى الاستبدال ممكناً رغم أن اليوم الواحد يتغذّى من عشرات السجلّات.
 *
 * ولا دالّة حذف بمشروع ولا بيوم في هذا الملف عمداً: صفٌّ كُتب يبقى ولو اختفى
 * سجلّه من القرص (كنس كلود بعد ~30 يوماً) — وذلك سبب وجود الجدول أصلاً.
 */

import { getConnection } from '@/modules/database/connection.js';

/** عدّادات التوكنز كما تُخزَّن (نفس تصنيف `TokenTotals` في المُستخرِجات). */
export type LedgerTokenTotals = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

/** صفٌّ جاهز للكتابة: (مشروع، يوم، مورّد، نموذج، جسم) لمصدر واحد. */
export type LedgerRowInput = {
  projectId: string;
  projectPath: string | null;
  day: string;
  vendor: string;
  model: string;
  harness: string;
  /** الكلفة المحسوبة؛ تبقى 0 حين `priced=false` وهي حينها **غياب سعر** لا صفر إنفاق. */
  costUsd: number;
  priced: boolean;
  assumed: boolean;
  tokens: LedgerTokenTotals;
  requests: number;
  pricesAsOf: string;
};

/** بصمة مصدر مُمسوح — مفتاح التخطّي في المسح التزايدي. */
export type LedgerSourceWatermark = {
  sourceKey: string;
  provider: string;
  mtimeMs: number;
  sizeBytes: number;
};

/** نطاق قراءة: المُعرِّف دائماً، والمسار جسرٌ لتاريخ سُجّل تحت مُعرِّف سابق. */
export type ProjectScope = {
  projectId: string;
  projectPath: string | null;
};

export type LedgerDailyRow = {
  day: string;
  totalUsd: number;
  /**
   * نفس `totalUsd` باسم النقطة على المنحنى. الاسمان مقصودان: القارئ الدفاعي
   * في مسار الإحصاءات يُسقط أي نقطة بلا `costUsd` (‏«لا كلفة» ليست صفراً)،
   * فاسمٌ واحد مختلف كان يُفرِغ الرسم البياني كلّه بصمت.
   */
  costUsd: number;
  requests: number;
  conversations: number;
  /** false حين أسهم في اليوم نموذج بلا سعر رسمي أو بسعر مفترَض. */
  complete: boolean;
  tokens: LedgerTokenTotals;
};

export type LedgerGroupRow = {
  /** اسم المورّد أو النموذج بحسب الاستعلام. */
  key: string;
  vendor: string;
  harness: string;
  totalUsd: number;
  requests: number;
  conversations: number;
  complete: boolean;
};

export type LedgerTotals = {
  totalUsd: number;
  requests: number;
  /** عدد السجلّات (المحادثات) التي أسهمت — مصدرٌ واحد = محادثة واحدة. */
  conversations: number;
  days: number;
  firstDay: string | null;
  lastDay: string | null;
  /**
   * `false` = لا صفّ واحد في السجلّ لهذا المشروع، أي **لم يُقَس بعد** —
   * لا «أنفق صفراً». التمييز جوهري: `COALESCE(SUM(...), 0)` يحوّل غياب
   * البيانات إلى صفر واثق، و`complete` تصير true بداهةً فوق صفر صفوف،
   * فيخرج «$0.00 مكتمل» عن مشروعٍ لم يُمسح قط.
   */
  measured: boolean;
  complete: boolean;
  unpricedModels: string[];
  assumedModels: string[];
  pricesAsOf: string | null;
};

const COLUMNS = `source_key, project_id, project_path, day, vendor, model, harness,
  cost_usd, priced, assumed, input_tokens, output_tokens,
  cache_write_5m_tokens, cache_write_1h_tokens, cache_read_tokens,
  requests, prices_as_of, updated_at`;

/**
 * شرط النطاق: المُعرِّف **أو** المسار. مشروعٌ حُذف صفّه من `projects` ثم
 * أُعيد تسجيله يحمل `project_id` جديداً، فبالمُعرِّف وحده يبدو تاريخه صفراً.
 */
const SCOPE_SQL = '(project_id = ? OR (? IS NOT NULL AND project_path = ?))';
const scopeParams = (scope: ProjectScope): [string, string | null, string | null] => [
  scope.projectId,
  scope.projectPath,
  scope.projectPath,
];

type TotalsDbRow = {
  total_usd: number | null;
  requests: number | null;
  conversations: number | null;
  days: number | null;
  first_day: string | null;
  last_day: string | null;
  unpriced_rows: number | null;
  assumed_rows: number | null;
  prices_as_of: string | null;
};

type DailyDbRow = {
  day: string;
  total_usd: number | null;
  requests: number | null;
  conversations: number | null;
  unpriced_rows: number | null;
  assumed_rows: number | null;
  input_tokens: number | null;
  output_tokens: number | null;
  cache_write_5m_tokens: number | null;
  cache_write_1h_tokens: number | null;
  cache_read_tokens: number | null;
};

type GroupDbRow = {
  key: string;
  vendor: string | null;
  harness: string | null;
  total_usd: number | null;
  requests: number | null;
  conversations: number | null;
  unpriced_rows: number | null;
  assumed_rows: number | null;
};

const num = (value: number | null | undefined): number => (Number.isFinite(value) ? Number(value) : 0);

const toGroupRow = (row: GroupDbRow): LedgerGroupRow => ({
  key: row.key,
  vendor: row.vendor ?? '',
  harness: row.harness ?? '',
  totalUsd: num(row.total_usd),
  requests: num(row.requests),
  conversations: num(row.conversations),
  complete: num(row.unpriced_rows) === 0 && num(row.assumed_rows) === 0,
});

/** ترشيح اليوم نصّياً: `day` بصيغة YYYY-MM-DD فترتيبها المعجمي = الزمني. */
const dayRangeSql = (since?: string, until?: string): { sql: string; params: string[] } => {
  const clauses: string[] = [];
  const params: string[] = [];
  if (since) {
    clauses.push('day >= ?');
    params.push(since);
  }
  if (until) {
    clauses.push('day <= ?');
    params.push(until);
  }
  return { sql: clauses.length > 0 ? ` AND ${clauses.join(' AND ')}` : '', params };
};

export const projectCostLedgerDb = {
  /**
   * يكتب مساهمة مصدر واحد كاملةً: **حذف كل صفوفه ثم إدراج المُعاد حسابه**،
   * وتحديث علامته المائية، في معاملة واحدة.
   *
   * عديم الأثر بالتكرار (idempotent) بحكم البنية لا بحكم الحرص: مسحُ نفس
   * السجلّ ألف مرّة يُنتج نفس الصفوف بنفس القيم. ولذلك **لا يوجد ولن يوجد**
   * مسارُ تحديثٍ يجمع على القيمة القائمة.
   *
   * `rows` فارغة مسموحة: سجلٌّ بلا استهلاك (أو خارج كل يوم معروف) يُسجَّل
   * بعلامته المائية وحدها فلا يُعاد فتحه في كل مسح.
   */
  replaceSource(watermark: LedgerSourceWatermark, rows: LedgerRowInput[]): number {
    const db = getConnection();

    // **لا يُحذف إلا ما سيُعاد كتابته.** الحذف الشامل لصفوف المصدر يجعل أي
    // سجلّ أُعيدت كتابته أقصرَ (ضغط، تدوير، بتر، تلف جزئي) يمحو أيام إنفاق
    // مضت محوَ الأبد — وهو عين ما وُجدت هذه الميزة لتمنعه. فيُحصر الحذف في
    // الأيام الحاضرة في القراءة الجديدة، وتبقى الأيام الغائبة كما سُجّلت.
    const remove = db.prepare('DELETE FROM project_cost_daily WHERE source_key = ? AND day = ?');
    const insert = db.prepare(
      `INSERT INTO project_cost_daily (${COLUMNS})
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(source_key, day, vendor, model, harness) DO UPDATE SET
         project_id = excluded.project_id,
         project_path = excluded.project_path,
         cost_usd = excluded.cost_usd,
         priced = excluded.priced,
         assumed = excluded.assumed,
         input_tokens = excluded.input_tokens,
         output_tokens = excluded.output_tokens,
         cache_write_5m_tokens = excluded.cache_write_5m_tokens,
         cache_write_1h_tokens = excluded.cache_write_1h_tokens,
         cache_read_tokens = excluded.cache_read_tokens,
         requests = excluded.requests,
         prices_as_of = excluded.prices_as_of,
         updated_at = CURRENT_TIMESTAMP`
    );
    const mark = db.prepare(
      `INSERT INTO project_cost_sources (source_key, provider, mtime_ms, size_bytes, scanned_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(source_key) DO UPDATE SET
         provider = excluded.provider,
         mtime_ms = excluded.mtime_ms,
         size_bytes = excluded.size_bytes,
         scanned_at = CURRENT_TIMESTAMP`
    );

    const run = db.transaction((entries: LedgerRowInput[]) => {
      // تُمسح أيام القراءة الجديدة وحدها ثم تُكتب — فتُصحَّح دون أن يُمحى يومٌ
      // لم تعد القراءة تغطّيه.
      for (const day of new Set(entries.map((entry) => entry.day))) {
        remove.run(watermark.sourceKey, day);
      }
      for (const row of entries) {
        insert.run(
          watermark.sourceKey,
          row.projectId,
          row.projectPath,
          row.day,
          row.vendor,
          row.model,
          row.harness,
          row.costUsd,
          row.priced ? 1 : 0,
          row.assumed ? 1 : 0,
          Math.round(row.tokens.input),
          Math.round(row.tokens.output),
          Math.round(row.tokens.cacheWrite5m),
          Math.round(row.tokens.cacheWrite1h),
          Math.round(row.tokens.cacheRead),
          Math.round(row.requests),
          row.pricesAsOf
        );
      }
      // العلامة المائية **بعد** الصفوف وفي نفس المعاملة: علامة تسبق الصفوف
      // تعني سجلّاً يُتخطّى للأبد بينما كلفته لم تُكتب قط.
      mark.run(watermark.sourceKey, watermark.provider, Math.round(watermark.mtimeMs), Math.round(watermark.sizeBytes));
    });

    run(rows);
    return rows.length;
  },

  /** العلامة المائية لمصدر، أو null إن لم يُمسح قط. */
  getSourceWatermark(sourceKey: string): LedgerSourceWatermark | null {
    const db = getConnection();
    const row = db
      .prepare('SELECT source_key, provider, mtime_ms, size_bytes FROM project_cost_sources WHERE source_key = ?')
      .get(sourceKey) as
      | { source_key: string; provider: string; mtime_ms: number; size_bytes: number }
      | undefined;

    return row
      ? {
          sourceKey: row.source_key,
          provider: row.provider,
          mtimeMs: num(row.mtime_ms),
          sizeBytes: num(row.size_bytes),
        }
      : null;
  },

  /**
   * كل العلامات المائية لمزوّد، كـMap. استعلامٌ واحد بدل استعلام لكل ملف:
   * المسح يمرّ على آلاف السجلّات ليقرّر أيّها تغيّر.
   */
  getSourceWatermarks(provider: string): Map<string, LedgerSourceWatermark> {
    const db = getConnection();
    const rows = db
      .prepare('SELECT source_key, provider, mtime_ms, size_bytes FROM project_cost_sources WHERE provider = ?')
      .all(provider) as { source_key: string; provider: string; mtime_ms: number; size_bytes: number }[];

    const map = new Map<string, LedgerSourceWatermark>();
    for (const row of rows) {
      map.set(row.source_key, {
        sourceKey: row.source_key,
        provider: row.provider,
        mtimeMs: num(row.mtime_ms),
        sizeBytes: num(row.size_bytes),
      });
    }
    return map;
  },

  /** إجمالي المشروع عبر كل تاريخه (أو داخل مدى أيام). */
  getTotals(scope: ProjectScope, range: { since?: string; until?: string } = {}): LedgerTotals {
    const db = getConnection();
    const dayRange = dayRangeSql(range.since, range.until);

    const row = db
      .prepare(
        `SELECT COALESCE(SUM(cost_usd), 0) AS total_usd,
                COALESCE(SUM(requests), 0) AS requests,
                COUNT(DISTINCT source_key) AS conversations,
                COUNT(DISTINCT day) AS days,
                MIN(day) AS first_day,
                MAX(day) AS last_day,
                COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0) AS unpriced_rows,
                COALESCE(SUM(CASE WHEN assumed = 1 THEN 1 ELSE 0 END), 0) AS assumed_rows,
                MAX(prices_as_of) AS prices_as_of
         FROM project_cost_daily
         WHERE ${SCOPE_SQL}${dayRange.sql}`
      )
      .get(...scopeParams(scope), ...dayRange.params) as TotalsDbRow;

    const unpriced = db
      .prepare(
        `SELECT DISTINCT model FROM project_cost_daily
         WHERE ${SCOPE_SQL}${dayRange.sql} AND priced = 0
         ORDER BY model`
      )
      .all(...scopeParams(scope), ...dayRange.params) as { model: string }[];

    const assumed = db
      .prepare(
        `SELECT DISTINCT model FROM project_cost_daily
         WHERE ${SCOPE_SQL}${dayRange.sql} AND assumed = 1
         ORDER BY model`
      )
      .all(...scopeParams(scope), ...dayRange.params) as { model: string }[];

    // صفر صفوف = لم يُقَس، لا «صفر إنفاق». وبلا قياس لا معنى لادّعاء الاكتمال.
    const measured = num(row?.conversations) > 0;

    return {
      totalUsd: num(row?.total_usd),
      requests: num(row?.requests),
      conversations: num(row?.conversations),
      days: num(row?.days),
      firstDay: row?.first_day ?? null,
      lastDay: row?.last_day ?? null,
      measured,
      complete: measured && num(row?.unpriced_rows) === 0 && num(row?.assumed_rows) === 0,
      unpricedModels: unpriced.map((entry) => entry.model),
      assumedModels: assumed.map((entry) => entry.model),
      pricesAsOf: row?.prices_as_of ?? null,
    };
  },

  /** السلسلة اليومية، الأقدم أولاً (رسمٌ بياني يقرأ من الأقدم للأحدث). */
  getDaily(scope: ProjectScope, range: { since?: string; until?: string } = {}): LedgerDailyRow[] {
    const db = getConnection();
    const dayRange = dayRangeSql(range.since, range.until);

    const rows = db
      .prepare(
        `SELECT day,
                COALESCE(SUM(cost_usd), 0) AS total_usd,
                COALESCE(SUM(requests), 0) AS requests,
                COUNT(DISTINCT source_key) AS conversations,
                COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0) AS unpriced_rows,
                COALESCE(SUM(CASE WHEN assumed = 1 THEN 1 ELSE 0 END), 0) AS assumed_rows,
                COALESCE(SUM(input_tokens), 0) AS input_tokens,
                COALESCE(SUM(output_tokens), 0) AS output_tokens,
                COALESCE(SUM(cache_write_5m_tokens), 0) AS cache_write_5m_tokens,
                COALESCE(SUM(cache_write_1h_tokens), 0) AS cache_write_1h_tokens,
                COALESCE(SUM(cache_read_tokens), 0) AS cache_read_tokens
         FROM project_cost_daily
         WHERE ${SCOPE_SQL}${dayRange.sql}
         GROUP BY day
         ORDER BY day ASC`
      )
      .all(...scopeParams(scope), ...dayRange.params) as DailyDbRow[];

    return rows.map((row) => ({
      day: row.day,
      totalUsd: num(row.total_usd),
      costUsd: num(row.total_usd),
      requests: num(row.requests),
      conversations: num(row.conversations),
      complete: num(row.unpriced_rows) === 0 && num(row.assumed_rows) === 0,
      tokens: {
        input: num(row.input_tokens),
        output: num(row.output_tokens),
        cacheWrite5m: num(row.cache_write_5m_tokens),
        cacheWrite1h: num(row.cache_write_1h_tokens),
        cacheRead: num(row.cache_read_tokens),
      },
    }));
  },

  /** تفصيل بالمورّد (الاشتراك المدفوع)، الأغلى أولاً. */
  getVendorTotals(scope: ProjectScope, range: { since?: string; until?: string } = {}): LedgerGroupRow[] {
    const db = getConnection();
    const dayRange = dayRangeSql(range.since, range.until);

    const rows = db
      .prepare(
        `SELECT vendor AS key,
                vendor,
                '' AS harness,
                COALESCE(SUM(cost_usd), 0) AS total_usd,
                COALESCE(SUM(requests), 0) AS requests,
                COUNT(DISTINCT source_key) AS conversations,
                COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0) AS unpriced_rows,
                COALESCE(SUM(CASE WHEN assumed = 1 THEN 1 ELSE 0 END), 0) AS assumed_rows
         FROM project_cost_daily
         WHERE ${SCOPE_SQL}${dayRange.sql}
         GROUP BY vendor
         ORDER BY total_usd DESC, vendor ASC`
      )
      .all(...scopeParams(scope), ...dayRange.params) as GroupDbRow[];

    return rows.map(toGroupRow);
  },

  /** تفصيل بالنموذج داخل جسمه، الأغلى أولاً. */
  getModelTotals(scope: ProjectScope, range: { since?: string; until?: string } = {}): LedgerGroupRow[] {
    const db = getConnection();
    const dayRange = dayRangeSql(range.since, range.until);

    const rows = db
      .prepare(
        `SELECT model AS key,
                vendor,
                harness,
                COALESCE(SUM(cost_usd), 0) AS total_usd,
                COALESCE(SUM(requests), 0) AS requests,
                COUNT(DISTINCT source_key) AS conversations,
                COALESCE(SUM(CASE WHEN priced = 0 THEN 1 ELSE 0 END), 0) AS unpriced_rows,
                COALESCE(SUM(CASE WHEN assumed = 1 THEN 1 ELSE 0 END), 0) AS assumed_rows
         FROM project_cost_daily
         WHERE ${SCOPE_SQL}${dayRange.sql}
         GROUP BY model, vendor, harness
         ORDER BY total_usd DESC, model ASC`
      )
      .all(...scopeParams(scope), ...dayRange.params) as GroupDbRow[];

    return rows.map(toGroupRow);
  },

  /**
   * كل المشاريع التي لها سطر في السجلّ (المُعرِّف ومساره). المسار من أحدث
   * صفّ، فإعادة تسمية المشروع لا تُنتج مساراً قديماً معروضاً.
   */
  listProjects(): { projectId: string; projectPath: string | null; totalUsd: number }[] {
    const db = getConnection();
    const rows = db
      .prepare(
        `SELECT project_id,
                MAX(project_path) AS project_path,
                COALESCE(SUM(cost_usd), 0) AS total_usd
         FROM project_cost_daily
         GROUP BY project_id
         ORDER BY total_usd DESC`
      )
      .all() as { project_id: string; project_path: string | null; total_usd: number | null }[];

    return rows.map((row) => ({
      projectId: row.project_id,
      projectPath: row.project_path,
      totalUsd: num(row.total_usd),
    }));
  },
};
