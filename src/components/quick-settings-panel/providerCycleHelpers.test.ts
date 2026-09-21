/**
 * اختبارات `providerCycleHelpers` — بوّابات الصدق قبل أي بكسل.
 *
 * كل حالة أدناه شرطُ قبول صريح من المراجعة النقدية للمرحلة 2:
 *  • مرساة `unknown`/`derived` ⇒ لا يُعرض موعد (‏N5): الشهر التقويمي المفترَض
 *    ليس تاريخ تجديد، وعرضه «يتجدّد بعد N» اختلاقٌ لموعد.
 *  • لا صفّ للمزوّد ⇒ لا شيء (غير مُصادَق عليه أو أخفاه المالك).
 *  • دورة انتهت ⇒ لا شيء بدل «بعد 0» أو رقم سالب.
 *  • عدّاد الأيام يُحسَب من لحظة مُمرَّرة، ولحظة نقصانه تُشتقّ من نهاية الدورة
 *    لا من منتصف ليل المتصفّح (‏M-12: القارئ قد يكون في منطقة غير منطقة الخادم).
 *
 * الصفوف مشتقّة من الحمولة الحيّة الفعلية لـ`GET /api/providers/costs/cycle`
 * على هذا الجهاز (‏2026-07-30): claude يوم 3 detected خطة «Max 20x»، وcodex يوم
 * 11 detected خطة «Plus»، وglm/antigravity/opencode/hermes يوم 1 unknown.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  findCycleRow,
  nextCountdownTickMs,
  resolveCycleDisplay,
  type ProviderCycleRow,
} from './providerCycleHelpers';

const LIVE_ROWS: ProviderCycleRow[] = [
  {
    provider: 'claude',
    displayName: 'Claude',
    plan: 'Max 20x',
    anchorDay: 3,
    anchorSource: 'detected',
    cycleStart: '2026-07-02T21:00:00.000Z',
    cycleEnd: '2026-08-02T21:00:00.000Z',
  },
  {
    provider: 'codex',
    displayName: 'Codex',
    plan: 'Plus',
    anchorDay: 11,
    anchorSource: 'detected',
    cycleStart: '2026-07-10T21:00:00.000Z',
    cycleEnd: '2026-08-10T21:00:00.000Z',
  },
  {
    provider: 'glm',
    displayName: 'GLM',
    plan: null,
    anchorDay: 1,
    anchorSource: 'unknown',
    cycleStart: '2026-06-30T21:00:00.000Z',
    cycleEnd: '2026-07-31T21:00:00.000Z',
  },
];

// 2026-07-30T02:00 بتوقيت الخادم (+03) = 2026-07-29T23:00Z.
const NOW = Date.parse('2026-07-29T23:00:00.000Z');

describe('findCycleRow', () => {
  it('يطابق على الجسم لا المورّد، وبلا حساسية لحالة الأحرف', () => {
    assert.equal(findCycleRow(LIVE_ROWS, 'codex')?.anchorDay, 11);
    assert.equal(findCycleRow(LIVE_ROWS, 'CODEX')?.anchorDay, 11);
    // `openai` هو المورّد لا الجسم — والعقد مفتاحه الجسم، ولهذا لا نسخة
    // عميلية من model-vendor.ts.
    assert.equal(findCycleRow(LIVE_ROWS, 'openai'), null);
  });

  it('غياب المزوّد أو الصفوف يعيد null لا صفّاً عشوائياً', () => {
    assert.equal(findCycleRow(LIVE_ROWS, null), null);
    assert.equal(findCycleRow(LIVE_ROWS, '  '), null);
    assert.equal(findCycleRow(null, 'codex'), null);
    assert.equal(findCycleRow(LIVE_ROWS, 'kimi'), null);
  });
});

describe('resolveCycleDisplay — بوّابة المرساة', () => {
  it('مرساة مُكتشَفة تُعرض، وتحمل الخطة ومصدرها', () => {
    const display = resolveCycleDisplay(findCycleRow(LIVE_ROWS, 'codex'), NOW);
    assert.notEqual(display, null);
    assert.equal(display?.plan, 'Plus');
    assert.equal(display?.anchorSource, 'detected');
    // من 29 يوليو 23:00Z إلى 10 أغسطس 21:00Z = 11.9 يوم ⇒ 12 يوماً.
    assert.equal(display?.daysRemaining, 12);
  });

  it('مرساة unknown لا تُعرض إطلاقاً (شهر تقويمي مفترَض ليس موعداً)', () => {
    assert.equal(resolveCycleDisplay(findCycleRow(LIVE_ROWS, 'glm'), NOW), null);
  });

  it('مرساة derived لا تُعرض: تقديرٌ من أقدم استهلاك لا واقعة فوترة', () => {
    const derived: ProviderCycleRow = {
      ...LIVE_ROWS[1],
      anchorSource: 'derived',
    };
    assert.equal(resolveCycleDisplay(derived, NOW), null);
  });

  it('مرساة manual تُعرض: المالك كتبها فهي واقعة عنده', () => {
    const manual: ProviderCycleRow = { ...LIVE_ROWS[1], anchorSource: 'manual', plan: null };
    const display = resolveCycleDisplay(manual, NOW);
    assert.equal(display?.anchorSource, 'manual');
    assert.equal(display?.plan, null);
  });

  it('لا صفّ ⇒ null', () => {
    assert.equal(resolveCycleDisplay(null, NOW), null);
    assert.equal(resolveCycleDisplay(undefined, NOW), null);
  });

  it('دورة انتهت أو نهاية غير صالحة ⇒ null لا «بعد 0 يوماً»', () => {
    const ended: ProviderCycleRow = { ...LIVE_ROWS[1], cycleEnd: '2026-07-01T00:00:00.000Z' };
    assert.equal(resolveCycleDisplay(ended, NOW), null);

    const exactlyNow: ProviderCycleRow = { ...LIVE_ROWS[1], cycleEnd: new Date(NOW).toISOString() };
    assert.equal(resolveCycleDisplay(exactlyNow, NOW), null);

    const broken: ProviderCycleRow = { ...LIVE_ROWS[1], cycleEnd: 'not-a-date' };
    assert.equal(resolveCycleDisplay(broken, NOW), null);
  });

  it('اليوم الأخير يُعرض 1 لا 0 (ما دامت الدورة لم تنتهِ فثمّة يومٌ باقٍ)', () => {
    const almost: ProviderCycleRow = {
      ...LIVE_ROWS[1],
      cycleEnd: new Date(NOW + 3 * 3_600_000).toISOString(),
    };
    assert.equal(resolveCycleDisplay(almost, NOW)?.daysRemaining, 1);
  });
});

describe('nextCountdownTickMs — إعادة الحساب في اللحظة الصحيحة', () => {
  it('اللحظة المُعادة تُنقص العدّاد فعلاً بواحد', () => {
    const end = Date.parse('2026-08-10T21:00:00.000Z');
    const before = Math.ceil((end - NOW) / 86_400_000);
    const tick = nextCountdownTickMs(end, NOW);

    assert.ok(tick > NOW, 'يجب أن تكون في المستقبل');
    const after = Math.ceil((end - tick) / 86_400_000);
    assert.equal(after, before - 1);
  });

  it('لا تتعلّق بمنتصف ليل المتصفّح: القارئ في منطقة أخرى يتغيّر عدّاده بنفس اللحظة', () => {
    const end = Date.parse('2026-08-10T21:00:00.000Z');
    // ثلاث لحظات «الآن» داخل نفس اليوم المحلّي تعطي نفس لحظة النقصان، لأنها
    // مشتقّة من نهاية الدورة لا من تقويم القارئ.
    const ticks = [NOW, NOW + 3_600_000, NOW + 7_200_000].map((now) => nextCountdownTickMs(end, now));
    assert.equal(new Set(ticks).size, 1);
  });
});
