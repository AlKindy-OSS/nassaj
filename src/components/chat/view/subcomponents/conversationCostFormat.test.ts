/**
 * conversationCostFormat.test.ts — تثبيت قواعد الصدق في عرض الكلفة.
 *
 * كل اختبار هنا يحرس ادّعاءً يُقرأ نقداً على الشاشة؛ كسره لا يُنتج «قبحاً»
 * بل رقماً كاذباً أمام المالك.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  buildCostSummaryLines,
  COST_DASH,
  formatCompactTokens,
  formatCostCount,
  formatCostUsd,
  formatWorkDuration,
  resolveCostDisplay,
  resolveCostSnapshotStatus,
  sumConversationCostTokens,
  sumCostTokens,
  type ConversationCost,
} from './conversationCostFormat';

const cost = (overrides: Partial<ConversationCost> = {}): ConversationCost => ({
  sessionId: 'sess-1',
  provider: 'claude',
  available: true,
  metered: false,
  totalUsd: 12.3456,
  complete: true,
  unpricedModels: [],
  subagentRequests: 0,
  pricesAsOf: '2026-07-28',
  perModel: [],
  ...overrides,
});

test('كلفة حقيقية دون السنت لا تُقرَّب صفراً', () => {
  assert.equal(formatCostUsd(0.004), '<$0.01');
  assert.equal(formatCostUsd(0.0000001), '<$0.01');
  assert.equal(formatCostUsd(0.009), '<$0.01');
});

test('الصفر الحرفي وحده يُكتب $0.00', () => {
  assert.equal(formatCostUsd(0), '$0.00');
});

test('المبالغ العادية والكبيرة بفواصل آلاف وخانتين', () => {
  assert.equal(formatCostUsd(0.01), '$0.01');
  assert.equal(formatCostUsd(12.3456), '$12.35');
  assert.equal(formatCostUsd(1234.5), '$1,234.50');
});

test('قيمة غير عددية أو سالبة تعني «لا نعرف» فتُردّ شرطة لا رقماً', () => {
  assert.equal(formatCostUsd(Number.NaN), COST_DASH);
  assert.equal(formatCostUsd(-1), COST_DASH);
  assert.equal(formatCostUsd(undefined), COST_DASH);
  assert.equal(formatCostUsd(null), COST_DASH);
  assert.equal(formatCostUsd('12.34'), COST_DASH);
});

test('عدّادات الطلبات والتوكنز', () => {
  assert.equal(formatCostCount(1234), '1,234');
  assert.equal(formatCostCount(-3), COST_DASH);
  assert.equal(formatCompactTokens(999), '999');
  assert.equal(formatCompactTokens(1500), '1.5K');
  assert.equal(formatCompactTokens(24_000), '24K');
  assert.equal(formatCompactTokens(2_400_000), '2.4M');
  assert.equal(formatCompactTokens(7_110_923_769), '7.11B');
  assert.equal(formatCompactTokens(0), '0');
});

test('مدة العمل المختصرة تحافظ على الوحدات المفيدة ولا تخترع قيمة عند غيابها', () => {
  assert.equal(formatWorkDuration(333), '333ms');
  assert.equal(formatWorkDuration(1_999), '1.9s');
  assert.equal(formatWorkDuration(125_000), '2m 5.0s');
  assert.equal(formatWorkDuration(3_780_000), '1h 3m 0.0s');
  assert.equal(formatWorkDuration(93_784_500), '1d 2h 3m 4.5s');
  assert.equal(formatWorkDuration(93_784_500, 'ar'), '1ي 2س 3د 4.5ث');
  assert.equal(formatWorkDuration(397 * 86_400_000 + 6_007), '1y 1mo 2d 6.0s');
  assert.equal(formatWorkDuration(undefined), COST_DASH);
  assert.equal(formatWorkDuration(-1), COST_DASH);
});

test('مجموع بنود التوكنز يتحمّل حقلاً ناقصاً', () => {
  assert.equal(
    sumCostTokens({ input: 10, output: 5, cacheWrite5m: 1, cacheWrite1h: 2, cacheRead: 7 }),
    25,
  );
  assert.equal(sumCostTokens(null), 0);
});

test('إجمالي الشارة هو مجموع بنود النماذج نفسها التي بُنيت عليها الكلفة', () => {
  assert.equal(
    sumConversationCostTokens(
      cost({
        perModel: [
          {
            model: 'model-a',
            costUsd: 1,
            requests: 2,
            tokens: { input: 10, output: 5, cacheWrite5m: 1, cacheWrite1h: 2, cacheRead: 7 },
          },
          {
            model: 'model-b',
            costUsd: 2,
            requests: 3,
            tokens: { input: 100, output: 50, cacheWrite5m: 10, cacheWrite1h: 20, cacheRead: 70 },
          },
        ],
      }),
    ),
    275,
  );
  assert.equal(sumConversationCostTokens(cost({ available: false })), null);
  assert.equal(sumConversationCostTokens(null), null);
});

test('أول جلب بلا رقم سابق حالة تحميل، والخطأ بلا رقم «غير متاح»', () => {
  assert.deepEqual(resolveCostDisplay({ status: 'loading', cost: null }), { kind: 'loading' });
  assert.deepEqual(resolveCostDisplay({ status: 'idle', cost: null }), { kind: 'loading' });
  assert.deepEqual(resolveCostDisplay({ status: 'error', cost: null }), {
    kind: 'unavailable',
    reason: null,
  });
});

test('available=false يُعرَض شرطةً بسببه لا $0.00', () => {
  const display = resolveCostDisplay({
    status: 'success',
    cost: cost({ available: false, reason: 'provider does not persist token usage', totalUsd: 0 }),
  });
  assert.deepEqual(display, {
    kind: 'unavailable',
    reason: 'provider does not persist token usage',
  });
});

test('إعادة الجلب فوق رقم قائم تُبقيه ظاهراً بلا وميض', () => {
  // بعد كل ردّ نُعيد الجلب؛ لو عادت الشارة إلى «جارٍ الحساب» لومضت في وجه
  // المستخدم عند كل رسالة.
  const display = resolveCostDisplay({ status: 'loading', cost: cost({ totalUsd: 3 }) });
  assert.deepEqual(display, { kind: 'amount', amount: '$3.00', partial: false, metered: false });
});

test('حالة اللقطة مستقلة عن اكتمال تسعير النماذج', () => {
  const partiallyPriced = cost({ complete: false, snapshotStatus: 'fresh' });
  assert.equal(resolveCostSnapshotStatus(partiallyPriced, 'success'), 'fresh');
});

test('حالة اللقطة تدعم الخادم القديم والتحديث والفشل فوق لقطة موجودة', () => {
  assert.equal(resolveCostSnapshotStatus(cost(), 'success'), 'fresh');
  assert.equal(resolveCostSnapshotStatus(cost(), 'loading'), 'refreshing');
  assert.equal(resolveCostSnapshotStatus(cost(), 'error'), 'stale');
  assert.equal(resolveCostSnapshotStatus(cost({ available: false }), 'success'), 'unavailable');
});

test('complete=false يرفع علم «جزئية» على الرقم', () => {
  const display = resolveCostDisplay({
    status: 'success',
    cost: cost({ complete: false, unpricedModels: ['glm-5.2'] }),
  });
  assert.deepEqual(display, { kind: 'amount', amount: '$12.35', partial: true, metered: false });
});

test('اشتراك غير مُقاس: سطر «مكافئ API» إلزامي مع أي رقم', () => {
  const lines = buildCostSummaryLines(cost({ metered: false }));
  assert.ok(lines.some((line) => line.key === 'apiEquivalent'));
  assert.ok(!lines.some((line) => line.key === 'billed'));
});

test('استهلاك مُقاس بمفتاح API يُقال «محاسَب» لا «مكافئ»', () => {
  const lines = buildCostSummaryLines(cost({ metered: true }));
  assert.ok(lines.some((line) => line.key === 'billed'));
  assert.ok(!lines.some((line) => line.key === 'apiEquivalent'));
});

test('metered=null يبقى غير متاح ولا يتحول إلى اشتراك', () => {
  const unknownAuth = cost({ metered: null, reason: 'authentication check unavailable' });
  assert.deepEqual(resolveCostDisplay({ status: 'success', cost: unknownAuth }), {
    kind: 'unavailable',
    reason: 'authentication check unavailable',
  });
  assert.deepEqual(buildCostSummaryLines(unknownAuth), [{
    key: 'unavailable',
    reason: 'authentication check unavailable',
  }]);
  assert.ok(!buildCostSummaryLines(unknownAuth).some((line) => line.key === 'apiEquivalent'));
});

test('الملخّص يذكر النماذج غير المسعَّرة والوكلاء الفرعيين وتاريخ الأسعار', () => {
  const lines = buildCostSummaryLines(
    cost({ complete: false, unpricedModels: ['glm-5.2', 'kimi-k2.6'], subagentRequests: 7 }),
  );
  assert.deepEqual(lines, [
    { key: 'apiEquivalent' },
    { key: 'partial', models: ['glm-5.2', 'kimi-k2.6'] },
    { key: 'subagents', count: 7 },
    { key: 'pricesAsOf', date: '2026-07-28' },
  ]);
});

test('بلا وكلاء فرعيين لا يظهر سطرهم', () => {
  const lines = buildCostSummaryLines(cost({ subagentRequests: 0 }));
  assert.ok(!lines.some((line) => line.key === 'subagents'));
});

test('غير المتاح لا يُذيَّل بسعرٍ ولا بتاريخ — لا رقم أصلاً ليُؤرَّخ', () => {
  const lines = buildCostSummaryLines(cost({ available: false, reason: '  ' }));
  assert.deepEqual(lines, [{ key: 'unavailable', reason: null }]);
});

test('بلا حمولة بعدُ لا أسطر', () => {
  assert.deepEqual(buildCostSummaryLines(null), []);
});


test('unpriced usage is unavailable, distinct from paid, free and empty zero snapshots', () => {
  const tokens = { input: 100, output: 10, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 };
  const unknown = { model: 'gpt-6-astra', costUsd: null, requests: 1, tokens };
  const unpriced = cost({ totalUsd: 0, complete: false, unpricedModels: ['gpt-6-astra'], perModel: [unknown] });
  assert.deepEqual(resolveCostDisplay({ status: 'success', cost: unpriced }), { kind: 'unavailable', reason: 'pricing_unavailable' });
  assert.equal(sumConversationCostTokens(unpriced), 110);
  assert.equal(buildCostSummaryLines(unpriced)[0].key, 'pricingUnavailable');
  for (const value of [0, 0.001, 1]) {
    const priced = cost({ totalUsd: value, perModel: [{ ...unknown, costUsd: value }] });
    assert.deepEqual(resolveCostDisplay({ status: 'success', cost: priced }), { kind: 'amount', amount: formatCostUsd(value), partial: false, metered: false });
    assert.ok(buildCostSummaryLines(priced).some((line) => line.key === 'baseRateEstimate'));
  }
  assert.deepEqual(resolveCostDisplay({ status: 'success', cost: cost({ totalUsd: 0 }) }), { kind: 'amount', amount: '$0.00', partial: false, metered: false });
});


test('base-rate disclosure follows Astra provider and case aliases', () => {
  for (const model of ['gpt-6-astra', 'openai/gpt-6-astra', 'GPT-6-ASTRA', 'openai/GPT-6-ASTRA-fast', 'gpt-6-astra-20260906']) {
    assert.ok(buildCostSummaryLines(cost({ perModel: [{ model, costUsd: 1, requests: 1, tokens: { input: 1, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 } }] })).some((line) => line.key === 'baseRateEstimate'), model);
  }
});

test('a zero subtotal for an unpriced token component remains unavailable', () => {
  const incomplete = cost({ totalUsd: 0, complete: false, unpricedModels: [], perModel: [{ model: 'gpt-6-astra', costUsd: 0, requests: 1, tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 1000, cacheRead: 0 } }] });
  assert.deepEqual(resolveCostDisplay({ status: 'success', cost: incomplete }), { kind: 'unavailable', reason: 'pricing_unavailable' });
  assert.equal(sumConversationCostTokens(incomplete), 1000);
});

// ─────────── اختبارات الأدوار (turns) — T-1676 / B-1021 ─────────────────────

import {
  buildTurnsMap,
  formatTurnFooter,
  type SessionCostTurn,
} from './conversationCostFormat';

const TURN_TOKENS = { input: 10_000, output: 3_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 5_000 };

const makeTurn = (id: string, overrides: Partial<SessionCostTurn> = {}): SessionCostTurn => ({
  assistantMessageId: id,
  startedAt: null,
  completedAt: null,
  requests: 1,
  models: ['claude-opus-5'],
  tokens: TURN_TOKENS,
  costUsd: 0.12,
  ...overrides,
});

test('buildTurnsMap: يُرجع خريطة فارغة حين تغيب turns', () => {
  assert.equal(buildTurnsMap(null).size, 0);
  assert.equal(buildTurnsMap(cost()).size, 0);
  assert.equal(buildTurnsMap(cost({ turns: [] })).size, 0);
});

test('buildTurnsMap: يُنشئ خريطة صحيحة من قائمة الأدوار', () => {
  const turn1 = makeTurn('msg-1');
  const turn2 = makeTurn('msg-2', { costUsd: null });
  const map = buildTurnsMap(cost({ turns: [turn1, turn2] }));
  assert.equal(map.size, 2);
  assert.deepEqual(map.get('msg-1'), turn1);
  assert.deepEqual(map.get('msg-2'), turn2);
  assert.equal(map.get('msg-x'), undefined);
});

test('formatTurnFooter: يجمع المدة والتوكنز والكلفة بفاصل "·"', () => {
  const result = formatTurnFooter('Took 42s', makeTurn('msg-1'), 'tokens');
  assert.ok(result.includes('Took 42s'), 'duration part');
  assert.ok(result.includes('·'), 'separator');
  assert.ok(result.includes('18K'), 'token count 10000+3000+5000=18000');
  assert.ok(result.includes('$0.12'), 'cost');
});

test('formatTurnFooter: يُعرض بلا كلفة حين costUsd = null', () => {
  const result = formatTurnFooter('Took 5s', makeTurn('msg-1', { costUsd: null }), 'tokens');
  assert.ok(result.includes('Took 5s'));
  assert.ok(!result.includes('$'));
  assert.ok(!result.includes(COST_DASH));
});

test('formatTurnFooter: يُعرض بلا تذييل حين يغيب الدور والمدة', () => {
  const result = formatTurnFooter(null, null, 'tokens');
  assert.equal(result, '');
});

test('formatTurnFooter: يُعرض المدة وحدها حين يغيب الدور', () => {
  const result = formatTurnFooter('استغرق 10 ث', null, 'توكن');
  assert.equal(result, 'استغرق 10 ث');
});

test('formatTurnFooter: لا يُعرض توكنز الصفر', () => {
  const turn = makeTurn('msg-z', { tokens: { input: 0, output: 0, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 }, costUsd: null });
  const result = formatTurnFooter('Took 1s', turn, 'tokens');
  // يجب ألّا يظهر "0 tokens" — الصفر لا يُضاف، والكلفة null لا تُضاف أيضاً
  assert.ok(!result.includes('tokens'), 'zero tokens should be hidden: got ' + result);
  assert.ok(!result.includes('$'), 'null cost should be hidden');
  assert.equal(result, 'Took 1s', 'only duration should appear');
});

// B-ALNUMAN-TRIM: regression — buildCostSummaryLines must not throw when a
// perModel entry has model: undefined (undefined JSON field omitted by server).
test('buildCostSummaryLines: لا يُطلق خطأ حين model غير معرَّف في أحد الإدخالات', () => {
  const entryWithUndefinedModel = {
    model: undefined as unknown as string,
    costUsd: 1.5,
    requests: 3,
    tokens: { input: 100, output: 50, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 0 },
  };
  const c = cost({ perModel: [entryWithUndefinedModel] });
  // Must not throw — the undefined model must be treated as non-Astra.
  assert.doesNotThrow(() => buildCostSummaryLines(c));
  const lines = buildCostSummaryLines(c);
  assert.ok(!lines.some((l) => l.key === 'baseRateEstimate'), 'undefined model is not Astra');
});
