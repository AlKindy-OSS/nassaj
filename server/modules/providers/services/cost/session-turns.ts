/**
 * بناء تفصيل الكلفة لكل **دور ردّ** من الطلبات الفريدة للمحادثة — دالّة صرفة
 * قابلة للاختبار بلا قرص ولا قاعدة ولا جدول أسعار (كلّها تُحقَن).
 *
 * الدور = رسالة المستخدم البشرية → الردّ النهائي، وقد يضمّ عدّة طلبات API
 * وحلقات أدوات ووكلاء فرعيين. مصدر الحدود مرتّبٌ بالأولوية:
 *
 *  1. **صف مقياس** (`response_turn_metrics`, ADR-126): نافذة `[startedAt,
 *     completedAt]` ومفتاحها `assistantMessageId` (uuid الرسالة النهائية). كل
 *     طلب يقع طابعه داخل النافذة يُنسب إلى هذا الدور.
 *  2. **احتياطي** لما قبل الميزة: تُجمَّع الطلبات غير المشمولة بأي نافذة في
 *     مقاطع تفصلها طوابع رسائل المستخدم البشرية، ومفتاح المقطع uuid آخر طلب
 *     فيه (الرسالة النهائية لذلك الدور).
 *
 * ثابتٌ محفوظ: كل طلب فريد يُنسَب إلى دور واحد لا غير، فمجموع توكنات الأدوار
 * يساوي مجموع `perModel` تماماً (يحرسه اختبار الانحدار).
 */

import type { SessionCostTokens, SessionCostTurn } from '@/shared/types.js';

import { priceModelUsage } from './cost-calculator.js';
import { emptyTotals, type ModelUsage, type RequestUsageRecord, type TokenTotals } from './usage-extractors.js';

/** صف مقياس دور كما يعيده `response_turn_metrics` (بلا `turnId` — غير معروض). */
export type TurnMetricWindow = {
  assistantMessageId: string;
  startedAt: string;
  completedAt: string;
};

/** يسعّر استهلاك نموذج واحد؛ يُحقَن كي تبقى الدالّة صرفة (الافتراضي المحرّك القائم). */
export type PriceModelFn = (usage: ModelUsage) => { costUsd: number | null };

type ResolvedWindow = {
  key: string;
  startedAt: string;
  completedAt: string;
  startMs: number;
  endMs: number;
};

type TurnAccumulator = {
  key: string;
  startedAt: string | null;
  completedAt: string | null;
  orderMs: number;
  perModel: Map<string, TokenTotals>;
  models: Set<string>;
  requests: number;
};

const addInto = (target: TokenTotals, source: TokenTotals): void => {
  target.input += source.input;
  target.output += source.output;
  target.cacheWrite5m += source.cacheWrite5m;
  target.cacheWrite1h += source.cacheWrite1h;
  target.cacheRead += source.cacheRead;
};

/** عدد الحدود الأصغر من أو المساوية للطابع — رقم المقطع الذي يقع فيه الطلب. */
const segmentIndex = (boundariesMs: number[], timestampMs: number): number => {
  let count = 0;
  for (const boundary of boundariesMs) {
    if (boundary <= timestampMs) count += 1;
    else break;
  }
  return count;
};

/**
 * @param requests الطلبات الفريدة (يُفترض ترتيبها الزمني؛ تُرتَّب دفاعياً).
 * @param metricWindows صفوف المقياس لهذه الجلسة (قد تكون فارغة).
 * @param userBoundariesMs طوابع رسائل المستخدم البشرية (حدود المسار الاحتياطي).
 * @param priceModel مسعّر النموذج المحقون.
 */
export function buildSessionTurns(
  requests: readonly RequestUsageRecord[],
  metricWindows: readonly TurnMetricWindow[],
  userBoundariesMs: readonly number[],
  priceModel: PriceModelFn = priceModelUsage,
): SessionCostTurn[] {
  if (requests.length === 0) return [];

  const ordered = [...requests].sort((a, b) => a.timestampMs - b.timestampMs
    || a.uuid.localeCompare(b.uuid));
  const boundaries = [...userBoundariesMs].sort((a, b) => a - b);

  const windows: ResolvedWindow[] = [];
  for (const row of metricWindows) {
    const startMs = Date.parse(row.startedAt);
    const endMs = Date.parse(row.completedAt);
    if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || endMs < startMs) continue;
    windows.push({ key: row.assistantMessageId, startedAt: row.startedAt, completedAt: row.completedAt, startMs, endMs });
  }
  windows.sort((a, b) => a.startMs - b.startMs);

  // مطابقة الطلب بنافذة، بثلاث طبقات مرتّبة بالثقة:
  //  1. **مطابقة معرّف** (`key === uuid`): مفتاح النافذة هو uuid الرسالة
  //     النهائية للدور، وهو عين ما تبحث به الواجهة. نافذة أوبوس المقيسة حياً
  //     تبدأ بعد صف النصّ بعشرات الميلي وبعد صف التفكير بثوانٍ، فلا يلتقطها
  //     احتواءٌ زمني؛ المطابقة بالمعرّف حصينة لهذا الانزياح.
  //  2. **احتواء زمني**: الطلبات الوسطية للدور (حلقات الأدوات) تقع داخل النافذة.
  //  3. **تداخل أي صف**: شبكة أمان لطلب يتداخل مداه [أبكر صف، آخر صف] مع النافذة.
  const firstMsOf = (request: RequestUsageRecord): number =>
    Number.isFinite(request.firstTimestampMs) ? (request.firstTimestampMs as number) : request.timestampMs;
  const findWindow = (request: RequestUsageRecord): ResolvedWindow | undefined =>
    windows.find((window) => window.key === request.uuid)
    ?? windows.find((window) => request.timestampMs >= window.startMs && request.timestampMs <= window.endMs)
    ?? windows.find((window) => firstMsOf(request) <= window.endMs && request.timestampMs >= window.startMs);

  // مفتاح المقطع الاحتياطي = uuid آخر طلب غير مشمول بنافذة فيه.
  const fallbackKeyBySegment = new Map<number, string>();
  for (const request of ordered) {
    if (findWindow(request)) {
      continue;
    }
    fallbackKeyBySegment.set(segmentIndex(boundaries, request.timestampMs), request.uuid);
  }

  const turns = new Map<string, TurnAccumulator>();
  const ensureTurn = (key: string, orderMs: number): TurnAccumulator => {
    let turn = turns.get(key);
    if (!turn) {
      turn = { key, startedAt: null, completedAt: null, orderMs, perModel: new Map(), models: new Set(), requests: 0 };
      turns.set(key, turn);
    }
    return turn;
  };

  for (const request of ordered) {
    const window = findWindow(request);
    let turn: TurnAccumulator;
    if (window) {
      turn = ensureTurn(window.key, window.startMs);
      // نهاية الدور = نهاية النافذة المقيسة. بدايته = نصّ النافذة المخزَّن كما
      // هو، إلا أن يسبق طابعُ صفٍّ فعلي بدايةَ النافذة (صف تفكير أوبوس: النافذة
      // المقيسة حياً تبدأ بعده لأن زمن التفكير غير مقيس بلا بثّ جزئي)، فنمدّها
      // إلى ذلك الطابع كي لا تُبخَس مدة أوبوس المعروضة.
      turn.completedAt = window.completedAt;
      const firstMs = firstMsOf(request);
      const candidateStart = Number.isFinite(firstMs) && firstMs < window.startMs
        ? new Date(firstMs).toISOString()
        : window.startedAt;
      if (turn.startedAt === null || Date.parse(candidateStart) < Date.parse(turn.startedAt)) {
        turn.startedAt = candidateStart;
      }
    } else {
      const key = fallbackKeyBySegment.get(segmentIndex(boundaries, request.timestampMs)) ?? request.uuid;
      turn = ensureTurn(key, request.timestampMs);
      // بلا صف مقياس: الحدود أدنى/أقصى طابع لطلبات الدور.
      const iso = new Date(request.timestampMs).toISOString();
      if (turn.startedAt === null || request.timestampMs < Date.parse(turn.startedAt)) turn.startedAt = iso;
      if (turn.completedAt === null || request.timestampMs > Date.parse(turn.completedAt)) turn.completedAt = iso;
    }

    const modelTotals = turn.perModel.get(request.model) ?? emptyTotals();
    addInto(modelTotals, request.totals);
    turn.perModel.set(request.model, modelTotals);
    turn.models.add(request.model);
    turn.requests += 1;
  }

  const result: SessionCostTurn[] = [];
  for (const turn of turns.values()) {
    const tokens: SessionCostTokens = emptyTotals();
    // أرضية مسعّرة تحاكي `totalUsd`: تُجمَع النماذج المسعّرة، ويُتجاهَل ما لا
    // سعر له (لا يُصفَّر ولا يُبطِل الدور). `null` فقط حين لا نموذج مسعّر البتّة
    // في الدور. بهذا يبقى مجموع كلف الأدوار مساوياً `totalUsd` تماماً.
    let costUsd: number | null = null;
    for (const [model, totals] of turn.perModel) {
      addInto(tokens, totals);
      const priced = priceModel({ model, totals, requests: 0 });
      if (priced.costUsd !== null) costUsd = (costUsd ?? 0) + priced.costUsd;
    }
    result.push({
      assistantMessageId: turn.key,
      startedAt: turn.startedAt,
      completedAt: turn.completedAt,
      requests: turn.requests,
      models: [...turn.models].sort(),
      tokens,
      costUsd,
    });
  }

  return result.sort((a, b) => turnOrderMs(a) - turnOrderMs(b)
    || a.assistantMessageId.localeCompare(b.assistantMessageId));
}

/** ترتيب زمني: بطابع البداية إن وُجد، وإلا يُدفَع إلى الآخر بثبات. */
const turnOrderMs = (turn: SessionCostTurn): number => {
  const parsed = turn.startedAt ? Date.parse(turn.startedAt) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : Number.MAX_SAFE_INTEGER;
};
