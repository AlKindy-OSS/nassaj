import assert from 'node:assert/strict';
import test from 'node:test';

import {
  calculateSessionCost,
  reconcileSessionCostTurnFloor,
  sumSessionCosts,
} from '@/modules/providers/services/cost/cost-calculator.js';
import type { SessionCostTurn } from '@/shared/types.js';
import {
  findModelPrice,
  normalizeModelId,
} from '@/modules/providers/services/cost/model-pricing.js';
import { emptyTotals, type SessionUsage } from '@/modules/providers/services/cost/usage-extractors.js';

const usageOf = (
  model: string,
  totals: Partial<ReturnType<typeof emptyTotals>>,
  provider = 'claude',
): SessionUsage => ({
  provider,
  perModel: [{ model, totals: { ...emptyTotals(), ...totals }, requests: 1 }],
  subagentRequests: 0,
  skipped: { synthetic: 0, duplicates: 0 },
});

test('المعادلة الرسمية: كل بند بسعره لا بسعر المدخلات', () => {
  // opus-5: ‏5/25 للمدخلات/المخرجات، و6.25 كتابة 5د، و10 كتابة ساعة، و0.5 قراءة.
  const cost = calculateSessionCost(
    usageOf('claude-opus-5', {
      input: 1_000_000,
      output: 1_000_000,
      cacheWrite5m: 1_000_000,
      cacheWrite1h: 1_000_000,
      cacheRead: 1_000_000,
    }),
  );

  assert.equal(cost.totalUsd, 5 + 25 + 6.25 + 10 + 0.5);
  assert.equal(cost.complete, true);
});

test('قراءة المخبّأ أرخص المكوّنات — ولو كانت أضخمها حجماً', () => {
  // الحالة الواقعية: قراءة مخبّأ ضخمة بجانب مخرجات صغيرة.
  const cost = calculateSessionCost(
    usageOf('claude-opus-5', { output: 26_757, cacheWrite1h: 105_436, cacheRead: 1_149_520, input: 4 }),
  );

  // احتساب القراءة بسعر المدخلات الكامل كان سيضاعف الرقم أضعافاً.
  const naiveIfCacheReadBilledAsInput = (1_149_520 / 1e6) * 5;
  assert.ok(cost.totalUsd < naiveIfCacheReadBilledAsInput + 2);
  assert.ok(cost.totalUsd > 0);
});

test('نموذج بلا سعر رسمي لا يُسعَّر صفراً بل يُعلَن ناقصاً', () => {
  const cost = calculateSessionCost(usageOf('some-unreleased-model-x9', { output: 500_000 }));

  assert.equal(cost.perModel[0].costUsd, null);
  assert.deepEqual(cost.unpricedModels, ['some-unreleased-model-x9']);
  assert.equal(cost.complete, false);
  // الإجمالي يبقى رقماً صادقاً لما أمكن تسعيره (صفر هنا) مع علم النقص مرفوعاً.
  assert.equal(cost.totalUsd, 0);
});

test('بند بسعر غير معلن يُحصى توكنزه بدل أن يُبتلع صمتاً', () => {
  // moonshot-v1-8k بلا سعر قراءة مخبّأ معلن.
  const cost = calculateSessionCost(
    usageOf('moonshot-v1-8k', { input: 1_000_000, cacheRead: 300_000 }, 'kimi'),
  );

  assert.equal(cost.totalUsd, 0.2);
  assert.equal(cost.unpricedComponentTokens, 300_000);
  assert.equal(cost.complete, false);
});

test('صفر جوجل للكتابة واقع تسعير لا نقص بيانات', () => {
  const cost = calculateSessionCost(
    usageOf('gemini-2.5-pro', { input: 1_000_000, cacheWrite5m: 500_000 }, 'antigravity'),
  );

  assert.equal(cost.totalUsd, 1.25);
  assert.equal(cost.unpricedComponentTokens, 0);
  assert.equal(cost.complete, true);
});

test('كلفة الوكلاء الفرعيين تدخل الإجمالي بسعر نموذجهم هم', () => {
  const usage: SessionUsage = {
    provider: 'claude',
    perModel: [
      { model: 'claude-opus-5', totals: { ...emptyTotals(), output: 1_000_000 }, requests: 3 },
      { model: 'claude-haiku-4-5', totals: { ...emptyTotals(), output: 1_000_000 }, requests: 9 },
    ],
    subagentRequests: 9,
    skipped: { synthetic: 0, duplicates: 0 },
  };

  const cost = calculateSessionCost(usage);
  assert.equal(cost.totalUsd, 25 + 5);
  assert.equal(cost.subagentRequests, 9);
});

test('مطابقة اسم النموذج: اللصيقة التاريخية والبادئة والحامل', () => {
  assert.equal(normalizeModelId('claude-opus-4-5-20251101'), 'claude-opus-4-5');
  assert.equal(normalizeModelId('anthropic/claude-sonnet-5'), 'claude-sonnet-5');
  assert.equal(normalizeModelId('us.anthropic.claude-opus-5'), 'anthropic.claude-opus-5');

  assert.equal(findModelPrice('claude-opus-4-5-20251101')?.inputPerMTok, 5);
  assert.equal(findModelPrice('anthropic/claude-sonnet-5', '2026-08-31')?.outputPerMTok, 10);
});

test('البادئة الأخصّ تفوز: codex-max لا يُسعَّر بسعر gpt-5.1 العام', () => {
  // كلاهما هنا بنفس السعر، لكن الترتيب هو ما يحمي عند اختلافهما مستقبلاً.
  assert.equal(findModelPrice('gpt-5.1-codex-max-20260101')?.inputPerMTok, 1.25);
  // متغيّر غير مُدرَج يقع على أقرب بادئة معروفة لا على null.
  assert.equal(findModelPrice('claude-opus-5-20260301')?.inputPerMTok, 5);
  // ما لا بادئة له إطلاقاً يبقى null.
  assert.equal(findModelPrice('llama-9-turbo'), null);
});

test('الجمع عبر المحادثات ينقل علم النقص لا يبتلعه', () => {
  const complete = calculateSessionCost(usageOf('claude-opus-5', { output: 1_000_000 }));
  const partial = calculateSessionCost(usageOf('mystery-model', { output: 1_000_000 }));

  const summed = sumSessionCosts([complete, partial]);
  assert.equal(summed.totalUsd, 25);
  assert.equal(summed.complete, false);
  assert.deepEqual(summed.unpricedModels, ['mystery-model']);
  assert.equal(summed.sessions, 2);
});

test('محادثة فارغة تعطي صفراً كاملاً لا نقصاً', () => {
  const cost = calculateSessionCost({
    provider: 'claude',
    perModel: [],
    subagentRequests: 0,
    skipped: { synthetic: 0, duplicates: 0 },
  });

  assert.equal(cost.totalUsd, 0);
  assert.equal(cost.complete, true);
});

test('مصالحة أرضية الأدوار محصورة في Codex ولا تجمع المصدرين', () => {
  const codex = calculateSessionCost(usageOf('gpt-5.6-sol', { output: 1 }, 'codex'));
  const turns: SessionCostTurn[] = [{
    assistantMessageId: 'turn-1', startedAt: null, completedAt: null, requests: 1,
    models: ['gpt-5.6-sol'], tokens: { ...emptyTotals(), output: 10 }, costUsd: 2,
  }];

  assert.equal(reconcileSessionCostTurnFloor(codex, turns).totalUsd, 2);

  const claude = { ...codex, provider: 'claude' };
  assert.equal(reconcileSessionCostTurnFloor(claude, turns), claude,
    'لا تتغير كلفة غير Codex حتى لو كانت أرضية الأدوار أعلى');
});


test('GPT-6 Astra uses verified Standard component rates instead of an unpriced zero', () => {
  const usage = usageOf('gpt-6-astra', {
    input: 100_000, output: 10_000, cacheRead: 50_000, cacheWrite5m: 20_000,
  }, 'codex');
  const cost = calculateSessionCost(usage);
  assert.equal(cost.totalUsd, 1.8); // $1 input + $0.50 output + $0.05 read + $0.25 write.
  assert.equal(cost.perModel[0].costUsd, 1.8);
  assert.deepEqual(cost.unpricedModels, []);
  assert.deepEqual(cost.assumedModels, []);
  assert.equal(cost.unpricedComponentTokens, 0);
  assert.equal(cost.complete, true);
});

test('GPT-6 Astra aliases retain rates, while unknown variants remain unpriced', () => {
  for (const alias of ['gpt-6-astra', 'openai/gpt-6-astra', 'GPT-6-ASTRA', 'gpt-6-astra-20260901', 'gpt-6-astra-high']) {
    assert.deepEqual(findModelPrice(alias), {
      inputPerMTok: 10, outputPerMTok: 50, cacheWrite5mPerMTok: 12.5,
      cacheWrite1hPerMTok: null, cacheReadPerMTok: 1,
    });
  }
  for (const unknown of ['gpt-6-astra-pro', 'gpt-6-astra-free', 'gpt-6-unknown']) {
    const cost = calculateSessionCost(usageOf(unknown, { input: 100_000 }, 'codex'));
    assert.equal(findModelPrice(unknown), null);
    assert.equal(cost.perModel[0].costUsd, null);
    assert.equal(cost.totalUsd, 0);
    assert.equal(cost.complete, false);
    assert.deepEqual(cost.unpricedModels, [unknown]);
  }
});

test('Astra session totals cannot establish a per-request long-context surcharge', () => {
  const usage = usageOf('gpt-6-astra', { input: 300_000, output: 20_000 }, 'codex');
  usage.perModel[0].requests = 10;
  assert.equal(calculateSessionCost(usage).totalUsd, 4);
});

test('Astra does not invent a one-hour cache price', () => {
  const cost = calculateSessionCost(usageOf('gpt-6-astra', { cacheWrite1h: 1_000 }, 'codex'));
  assert.equal(cost.unpricedComponentTokens, 1_000);
  assert.equal(cost.complete, false);
});
