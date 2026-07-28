/**
 * استخراج استهلاك التوكنز الفعلي من سجلّات المزوّدات على القرص.
 *
 * هذه الطبقة **قياس** لا تسعير: تُخرج عدّادات توكنز لكل نموذج، ويتولّى
 * `cost-calculator` ضربها بالأسعار الرسمية. الفصل مقصود — الأسعار تتغيّر
 * وقواعد القراءة لا تتغيّر.
 *
 * كل قاعدة هنا مُشتقّة من قياس على سجلّات حقيقية على هذا الجهاز (2026-07-28)،
 * لا من افتراض عن شكل الملفات:
 *
 *  • **كلود يكرّر الأسطر — سطر لكل كتلة محتوى** من ردّ API واحد، كلّها بنفس
 *    `message.id` و`requestId`. الجمع الساذج ضخّم المخرجات ‏2.0×–2.8×
 *    ⇒ إزالة التكرار بمفتاح (message.id, requestId) قبل أي جمع.
 *
 *  • **لكن الأسطر ليست نسخاً متطابقة، وهنا الفخّ المزدوج**: قيس على 4344
 *    مجموعة مكرَّرة حقيقية أن `output_tokens` **وحده** يتفاوت داخل المجموعة
 *    (‏2091 مجموعة)، وأن **الأخير يحمل القيمة الكاملة دائماً** (4344/4344،
 *    مثال حقيقي: ‏[5, 5, 5, 535]). الحقول المدخلة متطابقة في كل مجموعة بلا
 *    استثناء. ⇒ القاعدة: حقول المدخلات مرّة واحدة، والمخرجات = **الأكبر**.
 *    أخذ أول سطر (وهو ما يبدو صحيحاً على عيّنة صغيرة تتطابق فيها الأسطر)
 *    يبخس المخرجات ‏2.34× — وهي أغلى بنود الفاتورة.
 *
 *  • **الوكلاء الفرعيون في ملفات منفصلة.** لا وجود لـ`isSidechain:true` في
 *    ملف المحادثة الأمّ إطلاقاً (0 من 1884 ملفاً)؛ استهلاكهم في
 *    `<projects>/<sessionId>/**\/*.jsonl` (‏subagents/ ومنها workflows/).
 *    ⇒ تكلفة المحادثة = الأمّ + كل ما تحت مجلّدها، وإلا سقط عمل الوكلاء كلّه.
 *
 *  • **نموذج `<synthetic>`** يظهر في سجلّات كلود لرسائل مولَّدة محلياً
 *    (رسائل خطأ وما شابه) ولا يقابله طلب API ⇒ يُستبعَد لا يُسعَّر بصفر.
 *
 *  • **كودكس تراكمي لا تفاضلي.** كل حدث `token_count` يحمل
 *    `total_token_usage` تراكمياً منذ بداية المحادثة (وبجانبه
 *    `last_token_usage` للدور الأخير). جمع الأحداث يضاعف الكلفة أضعافاً
 *    ⇒ يُؤخذ آخر حدث فقط.
 *
 *  • **دلالة input في كودكس تخالف كلود**: ‏`input_tokens` لدى OpenAI شامل
 *    للمخبّأ، و`cached_input_tokens` جزء منه ⇒ غير المخبّأ = الفرق.
 *    بينما `input_tokens` لدى Anthropic لا يشمل المخبّأ أصلاً.
 */

import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

/** عدّادات التوكنز بتصنيف التسعير (لا بتصنيف المزوّد). */
export type TokenTotals = {
  /** مدخلات تُحاسَب بالسعر الكامل (غير مخبّأة). */
  input: number;
  output: number;
  /** كتابة إلى المخبّأ بعمر 5 دقائق (سعر أعلى من المدخلات لدى Anthropic). */
  cacheWrite5m: number;
  /** كتابة إلى المخبّأ بعمر ساعة. */
  cacheWrite1h: number;
  /** قراءة من المخبّأ (أرخص المكوّنات، وأكبرها حجماً عملياً). */
  cacheRead: number;
};

export type ModelUsage = {
  model: string;
  totals: TokenTotals;
  /** عدد الطلبات الفريدة (بعد إزالة التكرار) — مفيد للتشخيص لا للتسعير. */
  requests: number;
};

export type SessionUsage = {
  provider: string;
  perModel: ModelUsage[];
  /** كم من الطلبات الفريدة جاء من وكلاء فرعيين (تشخيص + عرض). */
  subagentRequests: number;
  /** ما أُسقط عمداً — يُعرض عند التشخيص فلا يبدو الفرق «خسارة صامتة». */
  skipped: { synthetic: number; duplicates: number };
};

/**
 * نافذة زمنية اختيارية (epoch ms). ضرورية لدورة الاشتراك الشهرية: محادثة
 * واحدة قد تمتدّ شهرين، فنسبة كلفتها كاملةً إلى شهر بدايتها تُفسد المجموع
 * الشهري في الاتجاهين. الترشيح بطابع كل رسالة لا بتاريخ فتح المحادثة.
 */
export type UsageWindow = { since?: number; until?: number };

const withinWindow = (timestamp: unknown, window?: UsageWindow): boolean => {
  if (!window || (window.since === undefined && window.until === undefined)) {
    return true;
  }

  const parsed = typeof timestamp === 'string' ? Date.parse(timestamp) : Number.NaN;
  if (!Number.isFinite(parsed)) {
    // سطر بلا طابع زمني صالح لا يُنسَب إلى نافذة بعينها — يُستبعَد من الحساب
    // المُنَفَّذ بنافذة (لا يُحشر في الشهر الجاري فيضخّمه).
    return false;
  }

  if (window.since !== undefined && parsed < window.since) {
    return false;
  }
  return !(window.until !== undefined && parsed >= window.until);
};

export const emptyTotals = (): TokenTotals => ({
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
});

const readNumber = (value: unknown): number => {
  const parsed = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null;

/** نموذج مولَّد محلياً بلا طلب API — لا يُسعَّر. */
export const SYNTHETIC_MODEL = '<synthetic>';

// ---------------------------------------------------------------------------
// كلود
// ---------------------------------------------------------------------------

/**
 * مُجمِّع قابل للتغذية سطراً سطراً عبر عدّة ملفات لمحادثة واحدة، بمجموعة
 * إزالة تكرار **مشتركة**: مُعرِّفات الطلبات فريدة عالمياً، فسطر مكرَّر بين
 * ملف الأمّ وملف وكيل فرعي يُحتسب مرّة واحدة.
 */
type PendingRequest = {
  model: string;
  isSubagent: boolean;
  /** حقول المدخلات — متطابقة عبر أسطر المجموعة، فتُثبَّت من أول سطر. */
  input: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
  /** المخرجات — تتزايد عبر الأسطر، فتُحفظ الأكبر. */
  output: number;
};

export class ClaudeUsageAccumulator {
  /**
   * سجلّ لكل طلب فريد لا مجرّد مجموعة مُعرِّفات: أسطر المجموعة الواحدة تحمل
   * مخرجات متفاوتة، فلا يكفي «شوهد من قبل ⇒ تخطَّ».
   */
  private readonly byRequest = new Map<string, PendingRequest>();
  private readonly anonymous: PendingRequest[] = [];
  private syntheticSkipped = 0;
  private duplicateSkipped = 0;

  constructor(private readonly window?: UsageWindow) {}

  /** يُغذّى بسطر JSONL مفكوك. يتجاهل بصمت ما ليس سطر استهلاك. */
  addEntry(entry: unknown): void {
    if (!isRecord(entry) || entry.type !== 'assistant') {
      return;
    }

    if (!withinWindow(entry.timestamp, this.window)) {
      return;
    }

    const message = isRecord(entry.message) ? entry.message : null;
    const usage = message && isRecord(message.usage) ? message.usage : null;
    if (!usage) {
      return;
    }

    const model = typeof message?.model === 'string' ? message.model : '';
    if (!model || model === SYNTHETIC_MODEL) {
      this.syntheticSkipped += 1;
      return;
    }

    // المفتاح المركّب لا message.id وحده: قيس على بيانات حقيقية أن الاثنين
    // يتطابقان تقريباً (103 مقابل 104 في ملف)، والمركّب هو الأدقّ.
    const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
    const cacheWrite5m = readNumber(cacheCreation?.ephemeral_5m_input_tokens);
    const cacheWrite1h = readNumber(cacheCreation?.ephemeral_1h_input_tokens);
    const cacheWriteTotal = readNumber(usage.cache_creation_input_tokens);
    // غياب التفصيل (سجلّات أقدم) ⇒ يُحمل الكل على 5 دقائق، وهو الافتراضي
    // الرسمي لعمر المخبّأ، فلا يُضخَّم الحساب بسعر الساعة الأعلى.
    const hasSplit = cacheWrite5m + cacheWrite1h > 0;

    const record: PendingRequest = {
      model,
      isSubagent: entry.isSidechain === true,
      input: readNumber(usage.input_tokens),
      output: readNumber(usage.output_tokens),
      cacheWrite5m: hasSplit ? cacheWrite5m : cacheWriteTotal,
      cacheWrite1h: hasSplit ? cacheWrite1h : 0,
      cacheRead: readNumber(usage.cache_read_input_tokens),
    };

    const messageId = typeof message?.id === 'string' ? message.id : '';
    const requestId = typeof entry.requestId === 'string' ? entry.requestId : '';
    // سطر بلا مُعرِّفين أصلاً لا يمكن نزع تكراره؛ يُحتسب (فقدُه أسوأ من تكراره).
    if (!messageId && !requestId) {
      this.anonymous.push(record);
      return;
    }

    const key = `${messageId}|${requestId}`;
    const existing = this.byRequest.get(key);
    if (!existing) {
      this.byRequest.set(key, record);
      return;
    }

    this.duplicateSkipped += 1;
    // المخرجات وحدها تتزايد عبر أسطر المجموعة ⇒ الأكبر هو الكامل. الحقول
    // المدخلة متطابقة (مقيسة)، فتُترك كما ثُبِّتت من أول سطر.
    if (record.output > existing.output) {
      existing.output = record.output;
    }
  }

  result(provider = 'claude'): SessionUsage {
    const byModel = new Map<string, ModelUsage>();
    let subagentRequests = 0;

    for (const record of [...this.byRequest.values(), ...this.anonymous]) {
      if (record.isSubagent) {
        subagentRequests += 1;
      }

      const current = byModel.get(record.model) ?? {
        model: record.model,
        totals: emptyTotals(),
        requests: 0,
      };
      current.totals.input += record.input;
      current.totals.output += record.output;
      current.totals.cacheWrite5m += record.cacheWrite5m;
      current.totals.cacheWrite1h += record.cacheWrite1h;
      current.totals.cacheRead += record.cacheRead;
      current.requests += 1;
      byModel.set(record.model, current);
    }

    return {
      provider,
      perModel: [...byModel.values()],
      subagentRequests,
      skipped: { synthetic: this.syntheticSkipped, duplicates: this.duplicateSkipped },
    };
  }
}

/** يقرأ ملف JSONL سطراً سطراً (لا readFile: بعض الملفات تتجاوز 100MB). */
async function feedJsonlFile(filePath: string, accumulator: ClaudeUsageAccumulator): Promise<void> {
  const stream = createReadStream(filePath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123 /* '{' */) {
        continue;
      }
      try {
        accumulator.addEntry(JSON.parse(line));
      } catch {
        // سطر مقطوع (كتابة جارية أثناء القراءة) — يُتخطّى ولا يُسقط الملف كلّه.
      }
    }
  } finally {
    lines.close();
    stream.destroy();
  }
}

/** يجمع كل ملفات JSONL تحت مجلّد، تنازلياً (subagents/ وworkflows/ ضمنها). */
async function collectJsonlFiles(directory: string): Promise<string[]> {
  const collected: string[] = [];

  const walk = async (current: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return; // مجلّد غير موجود = لا وكلاء فرعيين لهذه المحادثة.
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

/**
 * استهلاك محادثة كلود كاملة: ملف الأمّ + كل ملفات الوكلاء الفرعيين تحت
 * مجلّد يحمل اسم الجلسة بجانبه.
 *
 * @param transcriptPath المسار الكامل لملف `<sessionId>.jsonl`.
 */
export async function extractClaudeSessionUsage(
  transcriptPath: string,
  window?: UsageWindow,
): Promise<SessionUsage> {
  const accumulator = new ClaudeUsageAccumulator(window);

  try {
    await stat(transcriptPath);
    await feedJsonlFile(transcriptPath, accumulator);
  } catch {
    // لا ملف أمّ: قد تكون الجلسة وكيلاً فرعياً أو حُذف السجلّ — نُكمل للمجلّد.
  }

  const subagentDirectory = transcriptPath.replace(/\.jsonl$/, '');
  for (const file of await collectJsonlFiles(subagentDirectory)) {
    await feedJsonlFile(file, accumulator);
  }

  return accumulator.result('claude');
}

// ---------------------------------------------------------------------------
// كودكس
// ---------------------------------------------------------------------------

/**
 * استهلاك محادثة كودكس من ملف rollout.
 *
 * `total_token_usage` تراكمي ⇒ آخر حدث `token_count` هو الإجمالي. الجمع عبر
 * الأحداث يضاعف الرقم بعدد الأدوار.
 *
 * `input_tokens` لدى OpenAI شامل للمخبّأ، فالمحاسَب بالسعر الكامل هو الفرق؛
 * ومخرجات التفكير (`reasoning_output_tokens`) جزء من `output_tokens` لا
 * تُضاف إليها.
 */
export async function extractCodexSessionUsage(
  rolloutPath: string,
  window?: UsageWindow,
): Promise<SessionUsage> {
  let model = '';
  let latest: { input: number; cached: number; output: number } | null = null;
  /**
   * العدّاد تراكمي، فحصّة نافذة زمنية = (آخر عدّاد داخلها) − (آخر عدّاد قبلها)
   * طرحاً لا ترشيحاً. الترشيح وحده كان سينسب كل تاريخ المحادثة إلى الشهر الذي
   * صادف أن وقع فيه آخر دور.
   */
  let baseline: { input: number; cached: number; output: number } | null = null;

  const stream = createReadStream(rolloutPath, { encoding: 'utf8' });
  const lines = createInterface({ input: stream, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line || line.charCodeAt(0) !== 123) {
        continue;
      }

      let entry: unknown;
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }
      if (!isRecord(entry)) {
        continue;
      }

      const payload = isRecord(entry.payload) ? entry.payload : null;
      if (!payload) {
        continue;
      }

      // اسم النموذج يظهر في حدث التهيئة (session_meta/turn_context) لا مع العدّاد.
      const payloadModel = payload.model;
      if (typeof payloadModel === 'string' && payloadModel) {
        model = payloadModel;
      }

      if (payload.type !== 'token_count') {
        continue;
      }

      const info = isRecord(payload.info) ? payload.info : null;
      const total = info && isRecord(info.total_token_usage) ? info.total_token_usage : null;
      if (!total) {
        continue;
      }

      const snapshot = {
        input: readNumber(total.input_tokens),
        cached: readNumber(total.cached_input_tokens),
        output: readNumber(total.output_tokens),
      };

      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      const hasWindow = Boolean(window && (window.since !== undefined || window.until !== undefined));

      if (hasWindow && Number.isFinite(timestamp)) {
        if (window?.since !== undefined && timestamp < window.since) {
          // آخر عدّاد قبل النافذة = خطّ الأساس الذي يُطرح.
          baseline = snapshot;
          continue;
        }
        if (window?.until !== undefined && timestamp >= window.until) {
          continue;
        }
      }

      latest = snapshot;
    }
  } finally {
    lines.close();
    stream.destroy();
  }

  if (!latest) {
    return {
      provider: 'codex',
      perModel: [],
      subagentRequests: 0,
      skipped: { synthetic: 0, duplicates: 0 },
    };
  }

  const totals = emptyTotals();
  const windowedInput = Math.max(0, latest.input - (baseline?.input ?? 0));
  const windowedCached = Math.max(0, latest.cached - (baseline?.cached ?? 0));
  // القراءة من المخبّأ لا تُطرح مرتين: input شامل، فغير المخبّأ = input - cached.
  totals.input = Math.max(0, windowedInput - windowedCached);
  totals.cacheRead = windowedCached;
  totals.output = Math.max(0, latest.output - (baseline?.output ?? 0));

  return {
    provider: 'codex',
    perModel: [{ model: model || 'unknown', totals, requests: 1 }],
    subagentRequests: 0,
    skipped: { synthetic: 0, duplicates: 0 },
  };
}
