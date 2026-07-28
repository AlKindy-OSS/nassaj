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

/** حمولة `GET /api/providers/costs/session/:sessionId` (حقل `cost`). */
export type ConversationCost = {
  sessionId: string;
  provider: string;
  available: boolean;
  reason?: string;
  /** false = خطة اشتراك: الرقم قيمة مكافئة لا مبلغ محاسَب. */
  metered: boolean;
  totalUsd: number;
  complete: boolean;
  unpricedModels: string[];
  subagentRequests: number;
  pricesAsOf: string;
  perModel: ConversationCostModel[];
};

export type ConversationCostStatus = 'idle' | 'loading' | 'success' | 'error';

/** الشرطة المعروضة بدل رقم ملفَّق حين تتعذّر الكلفة. */
export const COST_DASH = '—';

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
  | { key: 'unavailable'; reason: string | null }
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

  const lines: CostSummaryLine[] = [cost.metered ? { key: 'billed' } : { key: 'apiEquivalent' }];

  if (!cost.complete) {
    lines.push({ key: 'partial', models: cost.unpricedModels ?? [] });
  }

  if (cost.subagentRequests > 0) {
    lines.push({ key: 'subagents', count: cost.subagentRequests });
  }

  lines.push({ key: 'pricesAsOf', date: cost.pricesAsOf });

  return lines;
}
