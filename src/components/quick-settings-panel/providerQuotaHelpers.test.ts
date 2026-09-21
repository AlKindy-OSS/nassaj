/**
 * اختبارات `providerQuotaHelpers` — بوّابات صدق نوافذ حصّة المزوّد.
 *
 * الصفوف مشتقّة من **الحمولتين الحيّتين** المقروءتين 2026-07-30:
 *  • glm (`api.z.ai/api/monitor/usage/quota/limit`): ‏`level:'lite'` وثلاث نوافذ
 *    — توكنز نَفِدت (100%) تُصفَّر بعد ساعتين، وتوكنز 29% بعد 17 ساعة، وأدوات
 *    MCP ‏2% بعد عشرة أيام.
 *  • codex (`chatgpt.com/backend-api/wham/usage`): ‏`plan_type:'plus'` ونافذة
 *    أساسية `used_percent:0` بطول 604800ث.
 *
 * المُثبَت: النافذة التي **مضى** موعد تصفيرها تُحذَف (وهي الحالة التي أسقطت
 * ملاذَ اللقطة المحلية لكودكس: لقطة 12 يوليو ونوافذها منتهية)، والنسبة غير
 * الرقمية لا تُكمَّل بصفر، والترتيب بالأقرب تصفيراً، ولحظة إعادة الحساب مشتقّة
 * من موعد التصفير لا من ساعة المتصفّح.
 *
 * RUNNER: vitest (`npm run test:client`).
 */

import assert from 'node:assert/strict';

import { describe, it } from 'vitest';

import {
  looksLikeAnthropicModel,
  resolveWindowLength,
  nextQuotaTickMs,
  resolveHorizon,
  resolveQuotaWindows,
  type ProviderQuotaPayload,
} from './providerQuotaHelpers';

const NOW = Date.parse('2026-07-30T00:04:17.472Z');

const GLM_LIVE: ProviderQuotaPayload = {
  provider: 'glm',
  plan: 'lite',
  windows: [
    { key: 'tools', usedPercent: 2, resetsAt: '2026-08-09T17:10:22.998Z' },
    { key: 'tokens1', usedPercent: 100, resetsAt: '2026-07-30T02:08:47.699Z' },
    { key: 'tokens2', usedPercent: 29, resetsAt: '2026-07-30T17:10:22.998Z' },
  ],
  observedAt: '2026-07-30T00:04:17.472Z',
};

const CODEX_LIVE: ProviderQuotaPayload = {
  provider: 'codex',
  plan: 'plus',
  windows: [
    { key: 'primary', usedPercent: 0, resetsAt: '2026-08-06T00:00:55.000Z', windowSeconds: 604800 },
  ],
};

describe('resolveHorizon', () => {
  it('يختار أكبر وحدة تُنتج رقماً ذا معنى', () => {
    assert.deepEqual(resolveHorizon('2026-07-30T02:08:47.699Z', NOW), { value: 3, unit: 'hour' });
    assert.deepEqual(resolveHorizon('2026-08-09T17:10:22.998Z', NOW), { value: 11, unit: 'day' });
    assert.deepEqual(resolveHorizon(new Date(NOW + 90_000).toISOString(), NOW), {
      value: 2,
      unit: 'minute',
    });
  });

  it('موعد مضى أو غير صالح ⇒ null (لا «بعد 0»)', () => {
    assert.equal(resolveHorizon('2026-07-12T00:46:24.125Z', NOW), null);
    assert.equal(resolveHorizon(new Date(NOW).toISOString(), NOW), null);
    assert.equal(resolveHorizon('not-a-date', NOW), null);
    assert.equal(resolveHorizon(null, NOW), null);
  });
});

describe('resolveQuotaWindows', () => {
  it('الحمولة الحيّة لـglm: ثلاث نوافذ مرتَّبة بالأقرب تصفيراً', () => {
    const views = resolveQuotaWindows(GLM_LIVE, NOW);
    assert.deepEqual(
      views.map((v) => v.key),
      ['tokens1', 'tokens2', 'tools'],
    );
    assert.equal(views[0].usedPercent, 100);
    assert.deepEqual(views[0].horizon, { value: 3, unit: 'hour' });
    assert.equal(views[2].usedPercent, 2);
  });

  it('الحمولة الحيّة لـcodex: نافذة واحدة بطولها كما أرسله المزوّد', () => {
    const views = resolveQuotaWindows(CODEX_LIVE, NOW);
    assert.equal(views.length, 1);
    assert.equal(views[0].usedPercent, 0);
    assert.equal(views[0].windowSeconds, 604800);
  });

  it('نافذة مضى تصفيرها تُحذَف — وهي حالة لقطة كودكس المحلية البائتة', () => {
    const stale: ProviderQuotaPayload = {
      provider: 'codex',
      plan: 'plus',
      windows: [
        // من لقطة 2026-07-12 الفعلية على القرص: النافذتان انتهتا منذ أسابيع.
        { key: 'primary', usedPercent: 16, resetsAt: '2026-07-11T23:02:55.000Z' },
        { key: 'secondary', usedPercent: 18, resetsAt: '2026-07-18T04:34:35.000Z' },
      ],
    };
    assert.deepEqual(resolveQuotaWindows(stale, NOW), []);
  });

  it('نسبة غير رقمية أو مفتاح فارغ ⇒ حذف لا صفر', () => {
    const broken = {
      provider: 'glm',
      plan: null,
      windows: [
        { key: 'a', usedPercent: Number.NaN, resetsAt: '2026-08-01T00:00:00.000Z' },
        { key: '', usedPercent: 10, resetsAt: '2026-08-01T00:00:00.000Z' },
        { key: 'c', usedPercent: '30' as unknown as number, resetsAt: '2026-08-01T00:00:00.000Z' },
      ],
    } as ProviderQuotaPayload;
    assert.deepEqual(resolveQuotaWindows(broken, NOW), []);
  });

  it('النسبة تُقصَر على [0,100] فلا 120% ولا سالب', () => {
    const odd: ProviderQuotaPayload = {
      provider: 'glm',
      plan: null,
      windows: [
        { key: 'over', usedPercent: 137, resetsAt: '2026-08-01T00:00:00.000Z' },
        { key: 'under', usedPercent: -5, resetsAt: '2026-08-02T00:00:00.000Z' },
      ],
    };
    const views = resolveQuotaWindows(odd, NOW);
    assert.equal(views[0].usedPercent, 100);
    assert.equal(views[1].usedPercent, 0);
  });

  it('حمولة غائبة أو بلا مصفوفة ⇒ لا نوافذ', () => {
    assert.deepEqual(resolveQuotaWindows(null, NOW), []);
    assert.deepEqual(resolveQuotaWindows({ provider: 'glm', plan: null } as ProviderQuotaPayload, NOW), []);
  });
});

describe('nextQuotaTickMs', () => {
  it('يعيد أقرب لحظة ينقص عندها أفقٌ فعلاً', () => {
    const views = resolveQuotaWindows(GLM_LIVE, NOW);
    const tick = nextQuotaTickMs(views, NOW);
    assert.ok(tick !== null && tick > NOW);

    // بعد المؤقّت يجب أن يكون أقرب أفق قد نقص (3س ⇒ 2س).
    const before = views[0].horizon.value;
    const after = resolveQuotaWindows(GLM_LIVE, tick as number)[0].horizon.value;
    assert.equal(after, before - 1);
  });

  it('لا نوافذ ⇒ لا مؤقّت', () => {
    assert.equal(nextQuotaTickMs([], NOW), null);
  });
});

describe('looksLikeAnthropicModel — احتياط ما قبل إعادة التشغيل', () => {
  it('أسماء عائلة Anthropic تُقبَل (فلا تختفي نوافذ كلود)', () => {
    for (const model of ['claude-opus-5', 'claude-sonnet-5', 'opus', 'sonnet', 'haiku', 'claude-fable-5']) {
      assert.equal(looksLikeAnthropicModel(model), true, model);
    }
  });

  it('نماذج المورّدين تُرفَض (فلا تُعرض حصّة Anthropic على استهلاك z.ai)', () => {
    for (const model of ['glm-5.2', 'glm-4.7', 'kimi-k2.6', 'gpt-5', 'deepseek-v4', 'big-pickle']) {
      assert.equal(looksLikeAnthropicModel(model), false, model);
    }
  });

  it('بادئة المورّد تحسم ضدّه مهما كان الاسم بعدها', () => {
    assert.equal(looksLikeAnthropicModel('glm/claude-ish'), false);
    assert.equal(looksLikeAnthropicModel('anthropic/claude-opus-5'), true);
  });

  it('الغياب أو الفراغ ⇒ false (والمستهلك يعالج «لا نموذج» بشرطه الخاص)', () => {
    assert.equal(looksLikeAnthropicModel(null), false);
    assert.equal(looksLikeAnthropicModel(''), false);
    assert.equal(looksLikeAnthropicModel('   '), false);
  });
});

describe('resolveWindowLength — حروف موحَّدة على كل المزوّدات', () => {
  it('الجلسة C والأسبوع W والشهر M — نفس حروف نوافذ كلود', () => {
    assert.equal(resolveWindowLength(18_000)?.letter, 'C', 'خمس ساعات');
    assert.equal(resolveWindowLength(604_800)?.letter, 'W', 'أسبوع');
    assert.equal(resolveWindowLength(2_592_000)?.letter, 'M', 'شهر 30 يوماً');
    assert.equal(resolveWindowLength(2_678_400)?.letter, 'M', 'شهر 31 يوماً');
  });

  it('نافذة الجلسة تحمل ساعاتها للتلميح (5 لا 18000)', () => {
    const session = resolveWindowLength(18_000);
    assert.equal(session?.kind, 'session');
    assert.equal(session?.value, 5);
  });

  it('السماح حول الأسبوع والشهر: المزوّد قد يرسل 7ي أو 30/31ي', () => {
    // نافذة كودكس الأسبوعية بالثانية بالضبط، ونافذة بستّة أيام ونصف.
    assert.equal(resolveWindowLength(604_800)?.letter, 'W');
    assert.equal(resolveWindowLength(6.5 * 86_400)?.letter, 'W');
    assert.equal(resolveWindowLength(28 * 86_400)?.letter, 'M');
  });

  it('كل ما دون اليوم جلسةٌ (‏C) بلا تثبيت رقم الساعات', () => {
    // خطةٌ بنافذة ثلاث ساعات تبقى C، فالحدّ بالطول لا برقم مثبَّت.
    assert.equal(resolveWindowLength(3 * 3_600)?.letter, 'C');
    assert.equal(resolveWindowLength(900)?.letter, 'C');
    assert.equal(resolveWindowLength(900)?.value, 1, 'يُقرَّب إلى ساعة لا صفر');
  });

  it('طولٌ غير قياسي ⇒ لا حرف بل عددٌ بالأيام (لا حرفٌ يكذب)', () => {
    const fortnight = resolveWindowLength(14 * 86_400);
    assert.equal(fortnight?.letter, null);
    assert.equal(fortnight?.kind, 'days');
    assert.equal(fortnight?.value, 14);
  });

  it('غياب الطول ⇒ null فيُعرض وسمٌ عام لا رقمٌ مختلق', () => {
    assert.equal(resolveWindowLength(undefined), null);
    assert.equal(resolveWindowLength(null), null);
    assert.equal(resolveWindowLength(0), null);
    assert.equal(resolveWindowLength(-5), null);
    assert.equal(resolveWindowLength(Number.NaN), null);
  });

  it('الطول والأفق شيئان مختلفان — وهذا جوهر البلاغ', () => {
    // النافذة الأسبوعية التي يتبقّى لتصفيرها 7 ساعات: الحرف W والأفق 7س.
    const weekly = resolveQuotaWindows(
      {
        provider: 'glm',
        plan: 'lite',
        windows: [
          {
            key: 'tokens2',
            usedPercent: 29,
            resetsAt: new Date(NOW + 7 * 3_600_000).toISOString(),
            windowSeconds: 604_800,
          },
        ],
      },
      NOW,
    )[0];
    assert.equal(resolveWindowLength(weekly.windowSeconds)?.letter, 'W');
    assert.deepEqual(weekly.horizon, { value: 7, unit: 'hour' });
  });
});
