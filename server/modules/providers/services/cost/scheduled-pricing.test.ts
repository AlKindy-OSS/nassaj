import assert from 'node:assert/strict';
import test from 'node:test';

import { findModelPrice, todayIso } from '@/modules/providers/services/cost/model-pricing.js';

test('سونيت 5 اليوم بالسعر الترويجي', () => {
  const price = findModelPrice('claude-sonnet-5', '2026-07-28');
  assert.equal(price?.inputPerMTok, 2);
  assert.equal(price?.outputPerMTok, 10);
});

test('آخر يوم في الفترة الترويجية ما زال ترويجياً', () => {
  const price = findModelPrice('claude-sonnet-5', '2026-08-31');
  assert.equal(price?.inputPerMTok, 2);
});

test('من 2026-09-01 ينتقل تلقائياً إلى السعر المعلَن — لا بخس صامت بالثلث', () => {
  const price = findModelPrice('claude-sonnet-5', '2026-09-01');
  assert.equal(price?.inputPerMTok, 3);
  assert.equal(price?.outputPerMTok, 15);
  assert.equal(price?.cacheWrite5mPerMTok, 3.75);
  assert.equal(price?.cacheWrite1hPerMTok, 6);
  assert.equal(price?.cacheReadPerMTok, 0.3);
});

test('السعر المجدول يطابق سونيت 4.6 — مرساة تحقّق مستقلة', () => {
  const future = findModelPrice('claude-sonnet-5', '2026-12-01');
  const anchor = findModelPrice('claude-sonnet-4-6', '2026-12-01');
  assert.equal(future?.inputPerMTok, anchor?.inputPerMTok);
  assert.equal(future?.outputPerMTok, anchor?.outputPerMTok);
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
