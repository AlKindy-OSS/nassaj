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
  resolveCostDisplay,
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
  assert.equal(formatCompactTokens(0), '0');
});

test('مجموع بنود التوكنز يتحمّل حقلاً ناقصاً', () => {
  assert.equal(
    sumCostTokens({ input: 10, output: 5, cacheWrite5m: 1, cacheWrite1h: 2, cacheRead: 7 }),
    25,
  );
  assert.equal(sumCostTokens(null), 0);
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
