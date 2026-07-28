import assert from 'node:assert/strict';
import test from 'node:test';

import { resolveAnchoredPlacement } from './anchoredPopover';

// design-ok: `left`/`right` هنا ليست أنماطاً بل **إحداثيات مقروءة** من مُخرَج
// دالّة تحسب موضع عنصر portal بالنسبة إلى نافذة المتصفح. الاختبار يتحقّق
// تحديداً من أن الاتجاه يقلبها (RTL يثبّت بـright وLTR بـleft)، فاستبدالها
// بخصائص منطقية يُلغي ما يقيسه هذا الملف. الشرح الكامل في anchoredPopover.ts.

const desktop = { width: 1440, height: 900 };
const phone = { width: 390, height: 780 };

/** زرّ في رأس المحادثة قرب الحافّة العلوية، بعرض شارة. */
const headerTrigger = (overrides: Partial<Record<string, number>> = {}) => ({
  top: 60,
  bottom: 88,
  left: 1180,
  right: 1260,
  width: 80,
  ...overrides,
});

test('تُفتح أسفل الزرّ مباشرة لا وسط الشاشة', () => {
  const placement = resolveAnchoredPlacement({
    trigger: headerTrigger(),
    viewport: desktop,
    measuredHeight: 260,
    preferredWidth: 320,
    isRtl: false,
  });

  assert.equal(placement.placement, 'below');
  // تحت الحافّة السفلى للزرّ بفاصل صغير — لا في منتصف الارتفاع.
  assert.equal(placement.top, 96);
  assert.notEqual(placement.top, (desktop.height - 260) / 2);
});

test('LTR يحاذي الحافّة اليسرى للزرّ، وRTL اليمنى', () => {
  // زرّ بعيد عن الحافّتين كي تُقاس المحاذاة نفسها لا القصّ عند الحافّة.
  const centred = headerTrigger({ left: 600, right: 680 });
  const ltr = resolveAnchoredPlacement({
    trigger: centred,
    viewport: desktop,
    measuredHeight: 200,
    preferredWidth: 320,
    isRtl: false,
  });
  assert.equal(ltr.left, 600);
  assert.equal(ltr.right, undefined);

  const rtl = resolveAnchoredPlacement({
    trigger: centred,
    viewport: desktop,
    measuredHeight: 200,
    preferredWidth: 320,
    isRtl: true,
  });
  // في RTL تُثبَّت بـ`right` كي تتمدّد يساراً بطبيعتها: 1440 − 680 = 760.
  assert.equal(rtl.right, 760);
  assert.equal(rtl.left, undefined);
});

test('لا تتجاوز حافّة النافذة مهما اقترب الزرّ منها', () => {
  // زرّ ملاصق للحافّة اليمنى في LTR: المحاذاة الساذجة تدفع النافذة خارج الشاشة.
  const placement = resolveAnchoredPlacement({
    trigger: headerTrigger({ left: 1400, right: 1436 }),
    viewport: desktop,
    measuredHeight: 200,
    preferredWidth: 320,
    isRtl: false,
  });

  assert.ok(placement.left !== undefined);
  assert.ok(placement.left + placement.width <= desktop.width, 'لا تتجاوز الحافّة اليمنى');
  assert.equal(placement.left, desktop.width - 320 - 16);
});

test('تنقلب فوق الزرّ حين لا تتّسع المساحة تحته', () => {
  // زرّ قرب أسفل الشاشة (رأس محادثة على شاشة قصيرة أو لوحة مفاتيح مفتوحة).
  const placement = resolveAnchoredPlacement({
    trigger: { top: 700, bottom: 728, left: 200, right: 280, width: 80 },
    viewport: phone,
    measuredHeight: 300,
    preferredWidth: 320,
    isRtl: false,
  });

  assert.equal(placement.placement, 'above');
  // مثبَّتة من الأسفل لا الأعلى: مهما نمت تتمدّد صعوداً ولا تغطّي الزرّ.
  assert.equal(placement.top, undefined);
  assert.equal(placement.bottom, phone.height - (700 - 8));
  assert.ok(placement.maxHeight <= 700 - 8 - 12, 'لا تتجاوز المساحة فوق الزرّ');
});

test('على شاشة الجوال يُقلَّص العرض بدل أن يفيض', () => {
  const placement = resolveAnchoredPlacement({
    trigger: { top: 60, bottom: 88, left: 300, right: 360, width: 60 },
    viewport: phone,
    measuredHeight: 240,
    preferredWidth: 320,
    isRtl: true,
  });

  // 390 − 12×2 = 366 ⇒ العرض المرغوب 320 يمرّ، لكن التثبيت يجب أن يبقى داخلياً.
  assert.ok(placement.width <= phone.width - 24);
  assert.ok(placement.right !== undefined && placement.right >= 12);
  assert.ok((placement.right ?? 0) + placement.width <= phone.width);
});

test('نافذة أطول من الشاشة كلها تُحصر بارتفاع قابل للتمرير لا تفيض', () => {
  const placement = resolveAnchoredPlacement({
    trigger: headerTrigger(),
    viewport: { width: 1024, height: 400 },
    measuredHeight: 900,
    preferredWidth: 320,
    isRtl: false,
  });

  assert.ok(placement.maxHeight <= 400 - 32);
  assert.ok(placement.maxHeight >= 140, 'يبقى ارتفاع صالح للقراءة');
  assert.ok((placement.top ?? placement.bottom ?? 0) >= 16);
});

test('قبل قياس الارتفاع (0) تُحسب موضعاً صالحاً لا NaN', () => {
  const placement = resolveAnchoredPlacement({
    trigger: headerTrigger(),
    viewport: desktop,
    measuredHeight: 0,
    preferredWidth: 320,
    isRtl: false,
  });

  assert.ok(Number.isFinite(placement.top ?? placement.bottom));
  assert.ok(Number.isFinite(placement.maxHeight));
  assert.equal(placement.placement, 'below');
});
