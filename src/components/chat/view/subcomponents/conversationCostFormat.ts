/**
 * conversationCostFormat.ts — منطق عرض كلفة المحادثة، صرفٌ وقابل للاختبار.
 *
 * الصدق هو الغرض كله هنا، لا التجميل:
 *  • مبلغ لم يُحسب **لا يُعرَض صفراً** — يُعرَض شرطةً مع سبب.
 *  • كلفة حقيقية أصغر من سنت لا تُقرَّب إلى `$0.00` بل `<$0.01`؛ الصفر الحرفي
 *    وحده (لا استهلاك) هو ما يُكتب `$0.00`.
 *  • اشتراك (Claude Max/ChatGPT/GLM) لا يقيس نقداً — الرقم عنده «مكافئ API»
 *    لا فاتورة، وسطر ذلك إلزامي في كل ملخّص لا خيار تحسيني.
 *
 * الأرقام غربية (0123) مثبَّتة بـ `en-US`: الشاشة موحّدة النظام الرقمي (سياسة
 * RTL للمنتج)، والاختبار يحتاج ناتجاً حتمياً لا يتبع لغة المتصفح.
 */

/** بنود التوكنز كما يُخرجها محرّك الكلفة الخادمي. */
export type ConversationCostTokens = {
  input: number;
  output: number;
  cacheWrite5m: number;
  cacheWrite1h: number;
  cacheRead: number;
};

export type ConversationCostModel = {
  model: string;
  /** null = لا سعر رسمي لهذا النموذج (لا «صفر»). */
  costUsd: number | null;
  requests: number;
  tokens: ConversationCostTokens;
};

/** حالة لقطة القياس نفسها — مستقلة عن اكتمال تسعير النماذج (`complete`). */
export type ConversationCostSnapshotStatus =
  | 'fresh'
  | 'stale'
  | 'refreshing'
  | 'incomplete'
  | 'unavailable';

/** حمولة `GET /api/providers/costs/session/:sessionId` (حقل `cost`). */
export type ConversationCost = {
  sessionId: string;
  provider: string;
  available: boolean;
  reason?: string;
  /** false = اشتراك مثبت؛ null = تعذّر فحص المصادقة، فلا يُصنَّف الرقم. */
  metered: boolean | null;
  totalUsd: number;
  complete: boolean;
  /**
   * قد تغيب هذه الحقول عند الاتصال بخادم أقدم؛ الواجهة تستنتج عندئذٍ
   * `fresh` من available و`unavailable` من !available.
   */
  snapshotStatus?: ConversationCostSnapshotStatus;
  snapshotAsOf?: string | null;
  snapshotReason?: string;
  unpricedModels: string[];
  subagentRequests: number;
  pricesAsOf: string;
  /** مجموع زمن العمل المنسوب إلى هذه المحادثة، بالميلي ثانية. */
  workDurationMs?: number;
  perModel: ConversationCostModel[];
  /**
   * تفصيل كلفة كل دور على حدة — يُضاف بخادم T-1676.
   * مرتَّب زمنياً، وكل عنصر يطابق `assistantMessageId` = message.id للرسالة
   * الختامية للردّ. يغيب الحقل عند الاتصال بخوادم أقدم؛ الواجهة تتعامل
   * مع غيابه بأمان (لا عرض بدل صفر).
   */
  turns?: SessionCostTurn[];
};

/**
 * تفصيل دور واحد في `SessionCostSummary.turns` (T-1676).
 * `assistantMessageId` يطابق `message.id` للرسالة النهائية للردّ — نفس
 * المفتاح الذي يستعمله `responseTurnMetric` في `MessageComponent`.
 */
export type SessionCostTurn = {
  assistantMessageId: string;
  startedAt: string | null;
  completedAt: string | null;
  requests: number;
  models: string[];
  tokens: ConversationCostTokens;
  costUsd: number | null;
};

export type ConversationCostStatus = 'idle' | 'loading' | 'success' | 'error';

/**
 * يحسم حالة اللقطة للعرض. طلب تحديث فوق لقطة موجودة لا يحجبها، بل يوسمها
 * refreshing إلى أن تصل اللقطة الجديدة. أمّا `complete` فلا يدخل هنا إطلاقاً:
 * فهو يصف الأسعار المنشورة، لا اكتمال فحص السجل.
 */
export function resolveCostSnapshotStatus(
  cost: ConversationCost | null,
  requestStatus: ConversationCostStatus,
): ConversationCostSnapshotStatus | null {
  if (!cost) return null;
  if (requestStatus === 'loading') return 'refreshing';
  if (requestStatus === 'error' && cost.available) return 'stale';
  if (cost.snapshotStatus) return cost.snapshotStatus;
  return cost.available ? 'fresh' : 'unavailable';
}

/** الشرطة المعروضة بدل رقم ملفَّق حين تتعذّر الكلفة. */
export const COST_DASH = '—';

export { formatWorkDuration } from '../../../../utils/workDurationFormat';

const USD_FORMAT = new Intl.NumberFormat('en-US', {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const COUNT_FORMAT = new Intl.NumberFormat('en-US');

/**
 * مبلغ بالدولار بصيغة مقروءة.
 * قيمة غير عددية أو سالبة تعني «لا نعرف» فتُردّ شرطةً — لا صفراً.
 */
export function formatCostUsd(value: unknown): string {
  const amount = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(amount) || amount < 0) {
    return COST_DASH;
  }
  if (amount === 0) {
    return '$0.00';
  }
  // أي كلفة حقيقية دون السنت تُقال «أقل من سنت»؛ `toFixed(2)` كان سيبتلعها صفراً.
  if (amount < 0.01) {
    return '<$0.01';
  }
  return `$${USD_FORMAT.format(amount)}`;
}

/** عدد صحيح بفواصل الآلاف (طلبات، نماذج، وكلاء فرعيون). */
export function formatCostCount(value: unknown): string {
  const count = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(count) || count < 0) {
    return COST_DASH;
  }
  return COUNT_FORMAT.format(Math.round(count));
}

/** عدّاد توكنز مضغوط للقائمة التفصيلية (نفس عرف TokenUsageSummary). */
export function formatCompactTokens(value: unknown): string {
  const count = typeof value === 'number' ? value : Number.NaN;
  if (!Number.isFinite(count) || count <= 0) {
    return '0';
  }
  if (count >= 1_000_000_000) {
    const billions = count / 1_000_000_000;
    const precision = billions < 10 ? 2 : billions < 100 ? 1 : 0;
    return `${billions.toFixed(precision)}B`;
  }
  if (count >= 1_000_000) {
    return `${(count / 1_000_000).toFixed(count >= 10_000_000 ? 0 : 1)}M`;
  }
  if (count >= 10_000) {
    return `${Math.round(count / 1_000)}K`;
  }
  if (count >= 1_000) {
    return `${(count / 1_000).toFixed(1)}K`;
  }
  return COUNT_FORMAT.format(count);
}

/**
 * مدة العمل المختصرة للشارة والملخّص والرسالة.
 *
 * نستخدم هذا المصدر الواحد كي لا تختلف مدة الدور عن إجمالي المحادثة. تبقى
 * أجزاء الثانية مفيدة حتى عندما تتجاوز المدة دقيقة أو ساعة، بينما تُحذف
 * الوحدات الصفرية كي لا تصبح الشارة مزدحمة.
 */

/** مجموع توكنز نموذج واحد — لسطر مختصر في القائمة التفصيلية. */
export function sumCostTokens(tokens: ConversationCostTokens | null | undefined): number {
  if (!tokens) return 0;
  return (
    (Number(tokens.input) || 0) +
    (Number(tokens.output) || 0) +
    (Number(tokens.cacheWrite5m) || 0) +
    (Number(tokens.cacheWrite1h) || 0) +
    (Number(tokens.cacheRead) || 0)
  );
}

/**
 * إجمالي التوكنز نفسه الذي مرّ إلى حاسبة الكلفة، بلا مصدر قياس ثانٍ.
 * `null` يعني أن مسار الكلفة لا يستطيع القياس؛ الصفر محفوظ للاستهلاك المقاس
 * الذي كانت قيمته صفراً فعلاً.
 */
export function sumConversationCostTokens(cost: ConversationCost | null): number | null {
  if (!cost?.available) return null;
  return cost.perModel.reduce((total, entry) => total + sumCostTokens(entry.tokens), 0);
}

/** Match the routing prefixes and case aliases accepted by server pricing. */
function isAstraModel(model: string | null | undefined): boolean {
  if (!model) return false;
  const normalized = model.trim().toLowerCase()
    .replace(/^(?:us|eu|apac)\./, '')
    .replace(/^[a-z0-9-]+\//, '');
  return /^gpt-6-astra(?:$|-)/.test(normalized);
}

/** An incomplete estimate cannot establish zero, even if one component is free. */
function hasUnavailablePricing(cost: ConversationCost): boolean {
  return !cost.complete && cost.totalUsd === 0;
}

export type CostDisplay =
  | { kind: 'loading' }
  | { kind: 'unavailable'; reason: string | null }
  | { kind: 'amount'; amount: string; partial: boolean; metered: boolean };

/**
 * ما تعرضه الشارة نفسها.
 *
 * إعادة جلب فوق كلفة موجودة تُبقي الرقم القديم ظاهراً (لا وميض «جارٍ الحساب»
 * بعد كل ردّ)، بينما أول جلب بلا رقم سابق هو وحده حالة التحميل.
 */
export function resolveCostDisplay(input: {
  status: ConversationCostStatus;
  cost: ConversationCost | null;
}): CostDisplay {
  const { status, cost } = input;

  if (!cost) {
    return status === 'error' ? { kind: 'unavailable', reason: null } : { kind: 'loading' };
  }

  if (!cost.available) {
    return { kind: 'unavailable', reason: cost.reason?.trim() ? cost.reason : null };
  }

  // `null` ليس اشتراكاً: يعني أن الخادم لم يستطع فحص نوع المصادقة. عرض
  // المبلغ كمحاسَب أو كمكافئ API سيكون ادعاءً بلا دليل، لذلك نفشل مغلقاً.
  if (cost.metered === null) {
    return { kind: 'unavailable', reason: cost.reason?.trim() ? cost.reason : null };
  }

  if (hasUnavailablePricing(cost)) {
    return { kind: 'unavailable', reason: 'pricing_unavailable' };
  }

  return {
    kind: 'amount',
    amount: formatCostUsd(cost.totalUsd),
    partial: !cost.complete,
    metered: cost.metered,
  };
}

/**
 * أسطر الشرح — مفاتيح مجرّدة يترجمها المكوّن، فيبقى هذا الملف بلا i18n
 * وقابلاً للاختبار على المعنى لا على النصّ.
 */
export type CostSummaryLine =
  | { key: 'pricingUnavailable'; models: string[] }
  | { key: 'unavailable'; reason: string | null }
  | { key: 'baseRateEstimate' }
  | { key: 'billed' }
  | { key: 'apiEquivalent' }
  | { key: 'partial'; models: string[] }
  | { key: 'subagents'; count: number }
  | { key: 'pricesAsOf'; date: string };

/**
 * يبني ملخّص الشرح بترتيب ثابت.
 *
 * سطر `billed`/`apiEquivalent` **حاضر دائماً** مع أي رقم: بدونه يقرأ المستخدم
 * قيمة اشتراك كأنها مبلغ خُصم منه — وهذا هو بالضبط ما لا يجوز.
 */
export function buildCostSummaryLines(cost: ConversationCost | null): CostSummaryLine[] {
  if (!cost) {
    return [];
  }

  if (!cost.available) {
    return [{ key: 'unavailable', reason: cost.reason?.trim() ? cost.reason : null }];
  }

  if (cost.metered === null) {
    return [{ key: 'unavailable', reason: cost.reason?.trim() ? cost.reason : null }];
  }

  const lines: CostSummaryLine[] = hasUnavailablePricing(cost)
    ? [{ key: 'pricingUnavailable', models: cost.unpricedModels ?? [] }]
    : [cost.metered ? { key: 'billed' } : { key: 'apiEquivalent' }];

  if (!cost.complete && !hasUnavailablePricing(cost)) {
    lines.push({ key: 'partial', models: cost.unpricedModels ?? [] });
  }

  if (cost.perModel.some((entry) => isAstraModel(entry.model) && entry.costUsd !== null)) {
    lines.push({ key: 'baseRateEstimate' });
  }

  if (cost.subagentRequests > 0) {
    lines.push({ key: 'subagents', count: cost.subagentRequests });
  }

  lines.push({ key: 'pricesAsOf', date: cost.pricesAsOf });

  return lines;
}

/**
 * يبني خريطة `Map<assistantMessageId, SessionCostTurn>` من حقل `turns` في
 * الكلفة. يُستدعى مرّة واحدة عند تغيّر الكلفة ويُمرَّر عبر context إلى
 * الرسائل — بلا جلب إضافي ولا إعادة حساب عند كل render.
 *
 * يُعيد خريطة فارغة (لا null) حين يغيب الحقل كي يبقى استهلاك الخريطة
 * بلا حراسة null في الاستدعاءات.
 *
 * **مطابقة المفتاح**: `assistantMessageId` هو `raw.uuid` المجرّد كما
 * يُصدره الخادم. الرسالة المعروضة في الواجهة تحمله في حقل
 * `message.transcriptMessageId` (لا في `message.id` الذي هو `${uuid}_${partIndex}`).
 * يجب البحث في الخريطة بـ`message.transcriptMessageId ?? message.id`.
 */
export function buildTurnsMap(cost: ConversationCost | null): Map<string, SessionCostTurn> {
  const map = new Map<string, SessionCostTurn>();
  if (!cost?.turns) return map;
  for (const turn of cost.turns) {
    map.set(turn.assistantMessageId, turn);
  }
  return map;
}

/**
 * نصّ مضغوط لتذييل رسالة المساعد: يجمع المدة مع التوكنز والكلفة من
 * الدور المطابق — كلٌّ منها اختياري إن لم يُتَح.
 * مثال: "استغرق 42 ث · 18.3K توكن · $0.12"
 */
export function formatTurnFooter(
  durationLabel: string | null,
  turn: SessionCostTurn | null | undefined,
  tokensLabel: string,
): string {
  const parts: string[] = [];

  if (durationLabel) parts.push(durationLabel);

  if (turn) {
    const totalTokens = sumCostTokens(turn.tokens);
    if (totalTokens > 0) {
      parts.push(`${formatCompactTokens(totalTokens)} ${tokensLabel}`);
    }
    if (turn.costUsd !== null && turn.costUsd >= 0 && Number.isFinite(turn.costUsd)) {
      parts.push(formatCostUsd(turn.costUsd));
    }
  }

  return parts.join(' · ');
}
