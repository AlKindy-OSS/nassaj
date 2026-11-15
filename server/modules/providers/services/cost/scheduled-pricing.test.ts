import assert from 'node:assert/strict';
import test from 'node:test';

import { findModelPrice, todayIso } from '@/modules/providers/services/cost/model-pricing.js';

// B-1796: صفحة التسعير (platform.claude.com/docs/en/about-claude/pricing،
// مقروءة 2026-11-14، الحاشية 3) تقول إن $2/$10 صار السعر القياسي لسونيت 5
// وإن الرفع المجدول إلى $3/$15 في 2026-09-01 «لن يحدث».
test('سونيت 5 بسعره القياسي $2/$10 قبل 2026-09-01', () => {
  const price = findModelPrice('claude-sonnet-5', '2026-07-28');
  assert.equal(price?.inputPerMTok, 2);
  assert.equal(price?.outputPerMTok, 10);
});

test('لا رفع وهمياً لسونيت 5 من 2026-09-01 فما بعد (B-1796)', () => {
  for (const day of ['2026-09-01', '2026-11-14', '2027-06-01']) {
    const price = findModelPrice('claude-sonnet-5', day);
    assert.equal(price?.inputPerMTok, 2, day);
    assert.equal(price?.outputPerMTok, 10, day);
    assert.equal(price?.cacheWrite5mPerMTok, 2.5, day);
    assert.equal(price?.cacheWrite1hPerMTok, 4, day);
    assert.equal(price?.cacheReadPerMTok, 0.2, day);
    assert.equal(price?.scheduled, undefined, day);
  }
});

test('نموذج بلا جدولة لا يتأثر بمرور الزمن', () => {
  for (const day of ['2026-07-28', '2027-01-01']) {
    assert.equal(findModelPrice('claude-opus-5', day)?.inputPerMTok, 5);
    assert.equal(findModelPrice('claude-fable-5', day)?.inputPerMTok, 10);
  }
});

test('فيبل-5 ضعف أوبوس-4.8 بالضبط في البنود الخمسة كلها', () => {
  const fable = findModelPrice('claude-fable-5');
  const opus = findModelPrice('claude-opus-4-8');
  assert.ok(fable && opus);
  assert.equal(fable.inputPerMTok, opus.inputPerMTok * 2);
  assert.equal(fable.outputPerMTok, opus.outputPerMTok * 2);
  assert.equal(fable.cacheWrite5mPerMTok, (opus.cacheWrite5mPerMTok ?? 0) * 2);
  assert.equal(fable.cacheWrite1hPerMTok, (opus.cacheWrite1hPerMTok ?? 0) * 2);
  assert.equal(fable.cacheReadPerMTok, (opus.cacheReadPerMTok ?? 0) * 2);
  // ولا يُوسَم تقديراً: السعر منشور رسمياً.
  assert.notEqual(fable.assumed, true);
});

test('todayIso تُنتج تاريخاً محلياً قابلاً للمقارنة النصّية', () => {
  assert.equal(todayIso(new Date(2026, 8, 1, 0, 30)), '2026-09-01');
  assert.equal(todayIso(new Date(2026, 7, 31, 23, 30)), '2026-08-31');
});
