import assert from 'node:assert/strict';
import test from 'node:test';

import { calculateSessionCost } from '@/modules/providers/services/cost/cost-calculator.js';
import { findModelPrice, PRICES_AS_OF } from '@/modules/providers/services/cost/model-pricing.js';

// الأرقام مقروءة من platform.claude.com/docs/en/about-claude/pricing في 2026-11-14 (B-1409).
const EXPECTED = {
  'claude-opus-5-5': { input: 4, output: 20, w5m: 5, w1h: 8, read: 0.2 },
  'claude-sonnet-5-5': { input: 2, output: 10, w5m: 2.5, w1h: 4, read: 0.1 },
  'claude-fable-5-2': { input: 8, output: 40, w5m: 10, w1h: 16, read: 0.2 },
  'claude-mythos-5-2': { input: 8, output: 40, w5m: 10, w1h: 16, read: 0.2 },
  'claude-fable-5-1': { input: 10, output: 50, w5m: 12.5, w1h: 20, read: 0.25 },
  'claude-mythos-5-1': { input: 10, output: 50, w5m: 12.5, w1h: 20, read: 0.25 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, w5m: 0.125, w1h: 0.2, read: 0.01 },
} as const;

for (const [model, want] of Object.entries(EXPECTED)) {
  test(`${model} مُسعَّر بسعره المنشور في البنود الخمسة`, () => {
    const price = findModelPrice(model);
    assert.ok(price, `${model} بلا سعر`);
    assert.equal(price.inputPerMTok, want.input);
    assert.equal(price.outputPerMTok, want.output);
    assert.equal(price.cacheWrite5mPerMTok, want.w5m);
    assert.equal(price.cacheWrite1hPerMTok, want.w1h);
    assert.equal(price.cacheReadPerMTok, want.read);
    // haiku-5-5 وحده موسوم: سعره بالشريحة والجدول يحمل الدنيا (انظر الاختبار أدناه).
    assert.equal(price.assumed === true, model === 'claude-haiku-5-5');
  });
}

// haiku-5-5 بالشريحة: موجّه >100k (المخبّأ يُحسَب في طوله) يدفع ‏$0.50/$2.50 لا
// ‏$0.10/$0.50. المجاميع لا تحمل طول كل طلب ⇒ الرقم حدٌّ أدنى، فيجب ألّا يُعرَض
// مقيساً: يدخل assumedModels وتسقط complete فتقول الواجهة «جزئية/تقدير».
test('haiku-5-5 يُعرَض حدّاً أدنى لا رقماً مقيساً', () => {
  const totals = { input: 1_000, output: 1_000, cacheWrite5m: 0, cacheWrite1h: 0, cacheRead: 150_000 };
  const cost = calculateSessionCost({
    provider: 'claude',
    perModel: [{ model: 'claude-haiku-5-5', totals, requests: 1 }],
    subagentRequests: 0,
    workDurationMs: null,
    skipped: { synthetic: 0, duplicates: 0 },
  });
  assert.deepEqual(cost.assumedModels, ['claude-haiku-5-5']);
  assert.equal(cost.complete, false);
});

test('PRICES_AS_OF يعكس آخر مراجعة للجدول (صفوف 5.x قُرئت 2026-11-14)', () => {
  assert.equal(PRICES_AS_OF, '2026-11-14');
});

test('لصيقة التاريخ تُحلّ إلى الصفّ الأخصّ لا إلى الأخ الأكبر', () => {
  assert.equal(findModelPrice('claude-opus-5-5-20261101')?.inputPerMTok, 4);
  assert.equal(findModelPrice('claude-fable-5-2-20261101')?.inputPerMTok, 8);
  assert.equal(findModelPrice('anthropic/claude-opus-5-5')?.outputPerMTok, 20);
  assert.equal(findModelPrice('claude-opus-5-5-high')?.outputPerMTok, 20);
});

test('الأخ الأكبر باقٍ على سعره: opus-5 وfable-5 لم يتغيّرا', () => {
  assert.equal(findModelPrice('claude-opus-5-20260301')?.inputPerMTok, 5);
  assert.equal(findModelPrice('claude-opus-5')?.cacheReadPerMTok, 0.5);
  assert.equal(findModelPrice('claude-fable-5')?.inputPerMTok, 10);
  assert.equal(findModelPrice('claude-fable-5')?.cacheReadPerMTok, 1);
});
