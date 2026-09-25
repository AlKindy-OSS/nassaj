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

import { open, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import { createInterface } from 'node:readline';

import {
  resolveCodexLinkedRollouts,
  withCodexRolloutRead,
  withTranscriptReadPermit,
  type CodexRolloutManifest,
} from '@/modules/providers/list/codex/codex-rollout-links.js';

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

/**
 * طلب API فريد واحد (بعد إزالة التكرار)، بطابعه الزمني ومُعرِّفه المطبّع، كي
 * يُجمَّع في «دور ردّ». يُلتقط فقط حين يُطلب صراحةً (`captureRequests`) لأن
 * مسارات النافذة/الدورة الشهرية لا تحتاجه. `uuid` هو `raw.uuid` لسطر السجل
 * الأكمل مخرَجاً في المجموعة — أي أقرب ما يطابق الرسالة النهائية التي تعرضها
 * الواجهة (وهو ما يُطبَع في `response_turn_metrics`).
 */
export type RequestUsageRecord = {
  uuid: string;
  model: string;
  timestampMs: number;
  /**
   * أبكر طابع نشاط للطلب (صف التفكير حين وُجد)؛ يساوي `timestampMs` حين صفّ
   * واحد. يمكّن بناء الأدوار من مدّ بداية الدور إلى أول نشاط فعلي حين تبدأ
   * نافذة المقياس بعد صف التفكير. اختياري: مستهلكون قدامى يبنون السجلّ يدوياً.
   */
  firstTimestampMs?: number;
  isSubagent: boolean;
  totals: TokenTotals;
};

export type SessionUsage = {
  provider: string;
  perModel: ModelUsage[];
  /** كم من الطلبات الفريدة جاء من وكلاء فرعيين (تشخيص + عرض). */
  subagentRequests: number;
  /**
   * مجموع زمن العمل الذي تصرّح به نتائج الأدوات/الوكلاء في السجل، بالميلي ثانية.
   * `null` يعني أن السجل لا يصرّح بمدة قابلة للقياس (وهو غير «صفر ميلي ثانية»).
   */
  workDurationMs: number | null;
  /** ما أُسقط عمداً — يُعرض عند التشخيص فلا يبدو الفرق «خسارة صامتة». */
  skipped: { synthetic: number; duplicates: number };
  /** Completeness of transcript discovery/reading, independent from pricing coverage. */
  snapshotStatus?: 'complete' | 'incomplete';
  snapshotReason?: string;
  /**
   * الطلبات الفريدة مرتّبةً زمنياً — يحضر فقط حين مُرِّر `captureRequests` (عرض
   * المحادثة الكاملة بلا نافذة ولا نسبة). يبنى منه تفصيل الأدوار في طبقة الخدمة.
   */
  requests?: RequestUsageRecord[];
  /** طوابع رسائل المستخدم البشرية (epoch ms)، حدود الأدوار حين لا صف مقياس. */
  userBoundariesMs?: number[];
};

/**
 * نافذة زمنية اختيارية (epoch ms). ضرورية لدورة الاشتراك الشهرية: محادثة
 * واحدة قد تمتدّ شهرين، فنسبة كلفتها كاملةً إلى شهر بدايتها تُفسد المجموع
 * الشهري في الاتجاهين. الترشيح بطابع كل رسالة لا بتاريخ فتح المحادثة.
 */
export type UsageWindow = { since?: number; until?: number };

/**
 * مرشِّح نسبةٍ اختياري: يُستدعى بطابع كل دور مساعد، ويُرجع `true` إن كان الدور
 * يخصّ المستخدم المستهدَف. غيابه = لا نسبة، أي احسب كل شيء (مجموع المحادثة).
 *
 * يعيش هنا مستقلاً عن `UsageWindow` لأن الفلترتين مختلفتا الطبيعة: النافذة
 * تسأل «متى؟» والنسبة تسأل «لمن؟»، والخلط بينهما يخفي إحداهما خلف الأخرى.
 */
export type UsageAttributionFilter = (timestampMs: number) => boolean;

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

/** طابع ISO → epoch ms، أو NaN حين يغيب أو يتعذّر تحليله. */
const parseTimestampMs = (value: unknown): number =>
  typeof value === 'string' ? Date.parse(value) : Number.NaN;

/**
 * هل تحمل حمولة رسالة المستخدم نصّاً بشرياً؟ سلسلة غير فارغة نعم؛ مصفوفة نعم
 * إن ضمّت جزء `text` واحداً على الأقل (لا نتائج أدوات فحسب — تلك استمرار دور
 * لا حدّ جديد).
 */
const hasHumanText = (content: unknown): boolean => {
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  return content.some((part) => isRecord(part) && (part.type === 'text' || part.type === 'input_text')
    && typeof part.text === 'string' && part.text.trim().length > 0);
};

/**
 * يفضّل جمع `totalDurationMs` من مخرجات الوكلاء/الأدوات: فهو زمن عملٍ صريح
 * وقد يجمع أعمالاً متوازية. بعض نسخ Codex تحفظ النتيجة JSON داخل `input_text`،
 * لذلك نفحص السلاسل أيضاً. لا نشتق المدة من طوابع المحادثة: فهي تشمل وقت
 * انتظار المستخدم وفترات التوقف. كما أن أحداث Codex `sub_agent_activity` التي
 * رُصدت تحمل `started` و`interacted` فقط، ولا توفر نهايةً زوجية موثوقة. المفتاح
 * الثابت للوكيل يمنع احتساب النتيجة نفسها ثانيةً حين تعود في مخرج الأب أو الطفل.
 */
/** Shared trusted-duration reducer; consumers must feed only decoded transcript entries. */
export class WorkDurationAccumulator {
  private total = 0;
  private measured = false;
  private readonly seen = new Set<string>();
  addEntry(entry: unknown, source: string): void {
    this.visit(entry, source);
  }

  result(): number | null {
    return this.measured ? this.total : null;
  }

  private add(duration: unknown, identity: string): void {
    const value = typeof duration === 'number' ? duration : Number(duration);
    if (!Number.isFinite(value) || value < 0 || !Number.isInteger(value) || this.seen.has(identity)) {
      return;
    }
    this.seen.add(identity);
    this.measured = true;
    this.total += value;
  }

  private visit(value: unknown, source: string): void {
    if (typeof value === 'string') {
      // مخرجات Codex النصية تحمل JSON مُضمّناً. نربط الرقم بـagentId إن وُجد؛
      // وإن غاب فموضعه داخل حدث المصدر يظل مفتاحاً آمناً من التكرار الحرفي.
      const coveredDurationOffsets = new Set<number>();
      const agentDurations = /"agentId"\s*:\s*"([^"\\]+)"[\s\S]{0,8192}?"totalDurationMs"\s*:\s*(\d+)/g;
      for (const match of value.matchAll(agentDurations)) {
        this.add(Number(match[2]), `agent:${match[1]}`);
        const durationOffset = match.index + match[0].lastIndexOf('"totalDurationMs"');
        coveredDurationOffsets.add(durationOffset);
      }
      const durations = /"totalDurationMs"\s*:\s*(\d+)/g;
      for (const match of value.matchAll(durations)) {
        if (coveredDurationOffsets.has(match.index)) continue;
        this.add(Number(match[1]), `${source}:text:${match.index}`);
      }
      return;
    }
    if (Array.isArray(value)) {
      value.forEach((item, index) => this.visit(item, `${source}:${index}`));
      return;
    }
    if (!isRecord(value)) return;

    if ('totalDurationMs' in value) {
      const agentId = typeof value.agentId === 'string' ? value.agentId : null;
      const eventId = typeof value.id === 'string'
        ? value.id
        : typeof value.call_id === 'string'
          ? value.call_id
          : null;
      this.add(value.totalDurationMs, agentId ? `agent:${agentId}` : eventId ? `event:${eventId}` : source);
    }
    for (const [key, nested] of Object.entries(value)) {
      this.visit(nested, `${source}.${key}`);
    }
  }
}

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
  /**
   * `uuid` وطابعه الزمني لـ**آخر** صف زمنياً في المجموعة (صف النصّ النهائي)،
   * لا صف التفكير: أوبوس يكتب صف `thinking` بمعرّف مستقل ثم صف `text` بنفس
   * `usage` تماماً، فالتقيّد بالأكبر مخرَجاً (متساوٍ هنا) كان يُبقي معرّف
   * التفكير. الواجهة تبحث بـ`transcriptMessageId` = uuid صف النصّ، فيجب أن
   * يتبع الدور هذا المعرّف. يُلتقطان فقط في وضع `captureRequests`.
   */
  uuid: string;
  timestampMs: number;
  /**
   * أبكر طابع صفٍّ في المجموعة (صف التفكير حين وُجد). يُستعمل في بناء الأدوار
   * لمدّ بداية الدور إلى أول نشاط فعلي حين تبدأ نافذة المقياس بعد صف التفكير.
   */
  firstTimestampMs: number;
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
  private readonly workDuration = new WorkDurationAccumulator();
  /** طوابع رسائل المستخدم البشرية (epoch ms) — حدود الأدوار في المسار الاحتياطي. */
  private readonly humanBoundariesMs: number[] = [];

  constructor(
    private readonly window?: UsageWindow,
    private readonly attribution?: UsageAttributionFilter,
    /** التقاط تفصيل كل طلب (uuid + طابع زمني) لبناء الأدوار. مطفأ افتراضياً. */
    private readonly captureRequests = false,
  ) {}

  /** يُغذّى بسطر JSONL مفكوك. يتجاهل بصمت ما ليس سطر استهلاك. */
  addEntry(entry: unknown): void {
    this.workDuration.addEntry(entry, 'claude');
    if (this.captureRequests && isRecord(entry) && entry.type === 'user') {
      this.recordHumanBoundary(entry);
    }
    if (!isRecord(entry) || entry.type !== 'assistant') {
      return;
    }

    if (!withinWindow(entry.timestamp, this.window)) {
      return;
    }

    // النسبة تُطبَّق **قبل** أي جمع أو إزالة تكرار: دورٌ لغير المستخدم المستهدَف
    // لا يدخل الحساب ولا يُسجَّل في `byRequest`، وإلا صار سطراً مكرَّراً لاحقاً
    // يبتلع دوراً حقيقياً بنفس المفتاح.
    if (this.attribution) {
      const timestampMs = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      if (!this.attribution(timestampMs)) {
        return;
      }
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
      uuid: this.captureRequests && typeof entry.uuid === 'string' ? entry.uuid : '',
      timestampMs: this.captureRequests ? parseTimestampMs(entry.timestamp) : Number.NaN,
      firstTimestampMs: this.captureRequests ? parseTimestampMs(entry.timestamp) : Number.NaN,
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
    // المُعرِّف والطابع = آخر صف **زمنياً** في المجموعة (صف النصّ النهائي)، لا
    // صف التفكير: أوبوس يكتب صف thinking بمعرّف مستقل ثم صف text بنفس usage
    // (output متساوٍ)، فالتقيّد بالأكبر مخرَجاً كان يُبقي معرّف التفكير ويكسر
    // مطابقة الواجهة (transcriptMessageId = uuid صف النصّ). نتتبّع أيضاً أبكر
    // طابع (firstTimestampMs) كي يمتدّ الدور إلى بداية التفكير في بناء الأدوار.
    if (this.captureRequests) {
      if (Number.isFinite(record.timestampMs)) {
        if (!Number.isFinite(existing.firstTimestampMs) || record.timestampMs < existing.firstTimestampMs) {
          existing.firstTimestampMs = record.timestampMs;
        }
        if (!Number.isFinite(existing.timestampMs) || record.timestampMs >= existing.timestampMs) {
          existing.timestampMs = record.timestampMs;
          if (record.uuid) existing.uuid = record.uuid;
        }
      } else if (record.uuid && !existing.uuid) {
        existing.uuid = record.uuid;
      }
    }
  }

  /**
   * رسالة مستخدم بشرية = حدّ دور: نصّية (لا نتيجة أداة فحسب) ومنشؤها بشري.
   * الرسائل الآلية (مطالبة المنسّق لوكيل فرعي، meta) ليست حدوداً بل جزء من دور
   * قائم. تُحترَم النافذة كما في مسار المساعد كي تتّسق الأدوار مع الاستهلاك.
   */
  private recordHumanBoundary(entry: Record<string, unknown>): void {
    if (entry.isMeta === true) return;
    const origin = isRecord(entry.origin) ? entry.origin : null;
    const originKind = typeof origin?.kind === 'string' ? origin.kind : '';
    if (originKind && originKind !== 'human') return;
    const message = isRecord(entry.message) ? entry.message : null;
    if (!message || message.role !== 'user') return;
    if (!hasHumanText(message.content)) return;
    if (!withinWindow(entry.timestamp, this.window)) return;
    const timestampMs = parseTimestampMs(entry.timestamp);
    if (Number.isFinite(timestampMs)) this.humanBoundariesMs.push(timestampMs);
  }

  /**
   * الطلبات الفريدة مرتّبةً زمنياً — للمسار الملتقِط وحده. **يشمل كل سجلّ
   * يحتسبه `result()`** بلا استثناء كي يبقى ثابت «مجموع الأدوار = perModel»
   * غير مشروط: السجلّ ناقص الـuuid (سطر بلا مُعرِّفين) يأخذ مفتاحاً بديلاً
   * ثابتاً، وناقص الطابع يُسنَد إلى طابع 0 فيقع في المقطع الأول — لا يُسقَط.
   */
  requests(): RequestUsageRecord[] {
    return [...this.byRequest.values(), ...this.anonymous]
      .map((record, index): RequestUsageRecord => ({
        uuid: record.uuid || `anon:${index}`,
        model: record.model,
        timestampMs: Number.isFinite(record.timestampMs) ? record.timestampMs : 0,
        firstTimestampMs: Number.isFinite(record.firstTimestampMs)
          ? record.firstTimestampMs
          : (Number.isFinite(record.timestampMs) ? record.timestampMs : 0),
        isSubagent: record.isSubagent,
        totals: {
          input: record.input,
          output: record.output,
          cacheWrite5m: record.cacheWrite5m,
          cacheWrite1h: record.cacheWrite1h,
          cacheRead: record.cacheRead,
        },
      }))
      .sort((a, b) => a.timestampMs - b.timestampMs || a.uuid.localeCompare(b.uuid));
  }

  /** طوابع رسائل المستخدم البشرية مرتّبةً تصاعدياً. */
  userBoundaries(): number[] {
    return [...this.humanBoundariesMs].sort((a, b) => a - b);
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
      workDurationMs: this.workDuration.result(),
      skipped: { synthetic: this.syntheticSkipped, duplicates: this.duplicateSkipped },
    };
  }
}

/** يقرأ ملف JSONL سطراً سطراً (لا readFile: بعض الملفات تتجاوز 100MB). */
async function feedJsonlFile(
  filePath: string,
  accumulator: ClaudeUsageAccumulator,
  signal?: AbortSignal,
  observation?: { unstable: boolean },
): Promise<void> {
  await withTranscriptReadPermit(signal, async () => {
  const handle = await open(filePath, 'r');
  const before = await handle.stat();
  const stream = handle.createReadStream({ encoding: 'utf8', signal, autoClose: false });
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
    const after = await handle.stat().catch(() => null);
    if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      if (observation) observation.unstable = true;
    }
    lines.close();
    stream.destroy();
    await handle.close().catch(() => undefined);
  }
  });
}

/** يجمع كل ملفات JSONL تحت مجلّد، تنازلياً (subagents/ وworkflows/ ضمنها). */
async function collectJsonlFiles(directory: string, signal?: AbortSignal): Promise<string[]> {
  const collected: string[] = [];

  const walk = async (current: string): Promise<void> => {
    signal?.throwIfAborted();
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      signal?.throwIfAborted();
      return; // مجلّد غير موجود = لا وكلاء فرعيين لهذه المحادثة.
    }

    for (const entry of entries) {
      signal?.throwIfAborted();
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
  attribution?: UsageAttributionFilter,
  signal?: AbortSignal,
  options: { captureRequests?: boolean } = {},
): Promise<SessionUsage> {
  const accumulator = new ClaudeUsageAccumulator(window, attribution, options.captureRequests === true);
  const observation = { unstable: false };

  try {
    await stat(transcriptPath);
    await feedJsonlFile(transcriptPath, accumulator, signal, observation);
  } catch {
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    // لا ملف أمّ: قد تكون الجلسة وكيلاً فرعياً أو حُذف السجلّ — نُكمل للمجلّد.
  }

  const subagentDirectory = transcriptPath.replace(/\.jsonl$/, '');
  for (const file of await collectJsonlFiles(subagentDirectory, signal)) {
    await feedJsonlFile(file, accumulator, signal, observation);
  }

  const usage = accumulator.result('claude');
  if (options.captureRequests) {
    usage.requests = accumulator.requests();
    usage.userBoundariesMs = accumulator.userBoundaries();
  }
  return observation.unstable
    ? { ...usage, snapshotStatus: 'incomplete', snapshotReason: 'A Claude transcript changed while usage was being read.' }
    : { ...usage, snapshotStatus: 'complete' };
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
  durationAccumulator?: WorkDurationAccumulator,
  signal?: AbortSignal,
  observation?: { unstable: boolean },
  beforePostStat?: () => Promise<void> | void,
  options: { captureRequests?: boolean; isSubagent?: boolean } = {},
): Promise<SessionUsage> {
  return withCodexRolloutRead(signal, async () => {
  let model = '';
  let latest: { input: number; cached: number; output: number } | null = null;
  let previousSnapshot: { input: number; cached: number; output: number } | null = null;
  const captured: RequestUsageRecord[] = [];
  const finalAssistantMessages: Array<{ id: string; timestampMs: number }> = [];
  const userBoundariesMs: number[] = [];
  let baseline: { input: number; cached: number; output: number } | null = null;
  const workDuration = durationAccumulator ?? new WorkDurationAccumulator();

  const handle = await open(rolloutPath, 'r');
  const before = await handle.stat();
  const stream = handle.createReadStream({ encoding: 'utf8', signal, autoClose: false });
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
      workDuration.addEntry(entry, rolloutPath);

      const payload = isRecord(entry.payload) ? entry.payload : null;
      if (!payload) {
        continue;
      }

      if (
        entry.type === 'response_item'
        && payload.type === 'message'
        && payload.role === 'assistant'
        && payload.phase === 'final_answer'
        && typeof payload.id === 'string'
        && payload.id
      ) {
        const timestampMs = parseTimestampMs(entry.timestamp);
        if (Number.isFinite(timestampMs)) finalAssistantMessages.push({ id: payload.id, timestampMs });
      }
      if (
        options.captureRequests
        && !options.isSubagent
        && entry.type === 'response_item'
        && payload.type === 'message'
        && payload.role === 'user'
        && hasHumanText(payload.content)
      ) {
        const timestampMs = parseTimestampMs(entry.timestamp);
        if (Number.isFinite(timestampMs)) userBoundariesMs.push(timestampMs);
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
      if (!total) continue;

      const snapshot = {
        input: readNumber(total.input_tokens),
        cached: readNumber(total.cached_input_tokens),
        output: readNumber(total.output_tokens),
      };

      const timestamp = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : Number.NaN;
      const hasWindow = Boolean(window && (window.since !== undefined || window.until !== undefined));
      const insideWindow = !hasWindow || !Number.isFinite(timestamp) || ((window?.since === undefined || timestamp >= window.since) && (window?.until === undefined || timestamp < window.until));
      if (hasWindow && Number.isFinite(timestamp)) {
        if (window?.since !== undefined && timestamp < window.since) { baseline = snapshot; previousSnapshot = snapshot; continue; }
        if (window?.until !== undefined && timestamp >= window.until) { previousSnapshot = snapshot; continue; }
      }
      latest = snapshot;
      if (options.captureRequests && insideWindow) {
        const last = info && isRecord(info.last_token_usage) ? info.last_token_usage : null;
        const source = last ?? { input_tokens: Math.max(0, snapshot.input - (previousSnapshot?.input ?? 0)), cached_input_tokens: Math.max(0, snapshot.cached - (previousSnapshot?.cached ?? 0)), output_tokens: Math.max(0, snapshot.output - (previousSnapshot?.output ?? 0)) };
        const capturedInput = readNumber(source.input_tokens);
        const capturedCached = Math.min(capturedInput, readNumber(source.cached_input_tokens));
        const capturedOutput = readNumber(source.output_tokens);
        if (capturedInput > 0 || capturedCached > 0 || capturedOutput > 0) {
          captured.push({
            uuid: `codex:${captured.length}`,
            model: model || 'unknown',
            timestampMs: Number.isFinite(timestamp) ? timestamp : 0,
            isSubagent: options.isSubagent === true,
            totals: { input: Math.max(0, capturedInput - capturedCached), cacheRead: capturedCached, output: capturedOutput, cacheWrite5m: 0, cacheWrite1h: 0 },
          });
        }
      }
      previousSnapshot = snapshot;
    }
    await beforePostStat?.();
  } finally {
    const after = await handle.stat().catch(() => null);
    if (!after || after.size !== before.size || after.mtimeMs !== before.mtimeMs) {
      if (observation) observation.unstable = true;
    }
    lines.close();
    stream.destroy();
    await handle.close().catch(() => undefined);
  }

  if (!latest) {
    return {
      provider: 'codex', perModel: [],
      subagentRequests: 0,
      workDurationMs: workDuration.result(),
      skipped: { synthetic: 0, duplicates: 0 },
    };
  }

  const totals = emptyTotals();
  const windowedInput = Math.max(0, latest.input - (baseline?.input ?? 0));
  const windowedCached = Math.max(0, latest.cached - (baseline?.cached ?? 0));
  totals.input = Math.max(0, windowedInput - windowedCached);
  totals.cacheRead = windowedCached;
  totals.output = Math.max(0, latest.output - (baseline?.output ?? 0));

  const requests = captured.map((request) => {
    const following = finalAssistantMessages.find((message) => message.timestampMs >= request.timestampMs);
    const preceding = [...finalAssistantMessages]
      .reverse()
      .find((message) => message.timestampMs <= request.timestampMs);
    // قد يقع `token_count` بين final الدور السابق وfinal الدور الذي يقيسه؛
    // لذا تكون الرسالة التالية هي المطابقة، والسابق احتياط عند غيابها.
    return { ...request, uuid: following?.id ?? preceding?.id ?? request.uuid };
  });
  return {
    provider: 'codex',
    perModel: [{ model: model || 'unknown', totals, requests: 1 }],
    subagentRequests: 0,
    workDurationMs: workDuration.result(),
    skipped: { synthetic: 0, duplicates: 0 },
    ...(options.captureRequests && requests.length > 0 ? { requests } : {}),
    ...(options.captureRequests && !options.isSubagent && userBoundariesMs.length > 0
      ? { userBoundariesMs: userBoundariesMs.sort((a, b) => a - b) }
      : {}),
  };
  });
}

/**
 * Codex conversation usage = coordinator rollout + only the child rollouts
 * explicitly linked by `sub_agent_activity.agent_thread_id` (recursively).
 */
export async function extractCodexConversationUsage(
  rootRolloutPath: string,
  window?: UsageWindow,
  options: { manifest?: CodexRolloutManifest; signal?: AbortSignal; captureRequests?: boolean } = {},
): Promise<SessionUsage> {
  const tree = options.manifest ?? await resolveCodexLinkedRollouts(rootRolloutPath, options.signal);
  const paths = tree.files.map((file) => file.rolloutPath);
  const workDuration = new WorkDurationAccumulator();
  const observation = { unstable: false };
  const usages = await Promise.all(
    paths.map((rolloutPath) => extractCodexSessionUsage(
      rolloutPath,
      window,
      workDuration,
      options.signal,
      observation,
      undefined,
      { captureRequests: options.captureRequests, isSubagent: rolloutPath !== tree.files[0]?.rolloutPath },
    )),
  );
  const byModel = new Map<string, ModelUsage>();
  const requests: RequestUsageRecord[] = [];
  const userBoundariesMs: number[] = [];
  const subagentRequests = tree.spawns.filter((spawn) => {
    if (!window || (window.since === undefined && window.until === undefined)) return true;
    if (spawn.occurredAtMs === null) return false;
    if (window.since !== undefined && spawn.occurredAtMs < window.since) return false;
    return window.until === undefined || spawn.occurredAtMs < window.until;
  }).length;

  for (const usage of usages) {
    if (usage.requests) requests.push(...usage.requests);
    if (usage.userBoundariesMs) userBoundariesMs.push(...usage.userBoundariesMs);
    for (const row of usage.perModel) {
      const current = byModel.get(row.model) ?? {
        model: row.model,
        totals: emptyTotals(),
        requests: 0,
      };
      current.totals.input += row.totals.input;
      current.totals.output += row.totals.output;
      current.totals.cacheWrite5m += row.totals.cacheWrite5m;
      current.totals.cacheWrite1h += row.totals.cacheWrite1h;
      current.totals.cacheRead += row.totals.cacheRead;
      current.requests += row.requests;
      byModel.set(row.model, current);
    }
  }

  const orderedRequests = requests.sort((a, b) => a.timestampMs - b.timestampMs || a.uuid.localeCompare(b.uuid));
  // لا تملك رسائل الوكيل الفرعي تذييلاً في المحادثة الأم. إن غابت نافذة قياس
  // تحفظ رابطها بالرد النهائي، فانسبها إلى أقرب طلب منسّق حتى لا يظهر دورٌ
  // يتيم لا تستطيع الواجهة مطابقته بأي رسالة ظاهرة.
  for (const request of orderedRequests) {
    if (!request.isSubagent) continue;
    const coordinator = orderedRequests.find((candidate) => !candidate.isSubagent
      && candidate.timestampMs >= request.timestampMs)
      ?? [...orderedRequests].reverse().find((candidate) => !candidate.isSubagent
        && candidate.timestampMs <= request.timestampMs);
    if (coordinator) request.uuid = coordinator.uuid;
  }
  const displayRequests = orderedRequests.filter((request) =>
    !request.isSubagent || orderedRequests.some((candidate) => !candidate.isSubagent
      && candidate.uuid === request.uuid));

  return {
    provider: 'codex',
    perModel: [...byModel.values()],
    subagentRequests,
    workDurationMs: workDuration.result(),
    skipped: { synthetic: 0, duplicates: 0 },
    snapshotStatus: tree.complete && !observation.unstable ? 'complete' : 'incomplete',
    ...(tree.limitReason || observation.unstable
      ? { snapshotReason: tree.limitReason ?? 'A Codex rollout changed while usage was being read.' }
      : {}),
    ...(options.captureRequests && displayRequests.length > 0
      ? { requests: displayRequests }
      : {}),
    ...(options.captureRequests && userBoundariesMs.length > 0
      ? { userBoundariesMs: userBoundariesMs.sort((a, b) => a - b) }
      : {}),
  };
}
