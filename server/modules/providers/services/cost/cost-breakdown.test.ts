/**
 * cost-breakdown — التجميع الذي يفشل بصمت إن أخطأ.
 *
 * الاختبار الأهمّ هنا واحد: **مجموع الجسم = مجموع صفوف نماذجه بالضبط**. مجموع
 * مضخَّم أو منقوص لا يرمي استثناءً ولا يكسر صفحة؛ يظهر رقماً معقولاً وخاطئاً.
 * وبعده قواعد صدق ADR-078: النموذج بلا سعر يبقى ظاهراً بلا مبلغ، وهو نفسه سبب
 * «جزئي»، ولا يُبتلع في مجموع يبدو كاملاً.
 *
 * RUNNER: ‏DATABASE_PATH="$(mktemp -d)/auth.db" npx tsx --tsconfig server/tsconfig.json --test <file>
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  aggregateCostBreakdown,
  breakdownFromSessionCosts,
  buildHarnessBreakdown,
  type BreakdownInput,
} from './cost-breakdown.js';
import { calculateSessionCost } from './cost-calculator.js';
import type { ModelCost } from './cost-calculator.js';
import type { TokenTotals } from './usage-extractors.js';

const totals = (overrides: Partial<TokenTotals> = {}): TokenTotals => ({
  input: 0,
  output: 0,
  cacheWrite5m: 0,
  cacheWrite1h: 0,
  cacheRead: 0,
  ...overrides,
});

const model = (
  name: string,
  costUsd: number | null,
  overrides: Partial<ModelCost> = {},
): ModelCost => ({
  model: name,
  costUsd,
  requests: 1,
  tokens: totals({ input: 100, output: 50 }),
  ...overrides,
});

const session = (provider: string, perModel: ModelCost[], rest: Partial<BreakdownInput> = {}): BreakdownInput => ({
  provider,
  perModel,
  complete: true,
  ...rest,
});

describe('buildHarnessBreakdown', () => {
  it('يجمع نفس النموذج عبر محادثات، والمجموع = مجموع صفوفه بالضبط', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('opus', 1.25), model('sonnet', 0.5)]),
      session('claude', [model('opus', 2.75)]),
    ]);

    assert.equal(breakdown.perModel.length, 2);
    const opus = breakdown.perModel.find((row) => row.model === 'opus');
    assert.equal(opus?.costUsd, 4);
    assert.equal(opus?.sessions, 2);
    assert.equal(opus?.requests, 2);

    // الخاصيّة المركزية: لا فرق ولو عائماً.
    const sumOfParts = breakdown.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    assert.equal(breakdown.totalUsd, sumOfParts);
    assert.equal(breakdown.totalUsd, 4.5);
    assert.equal(breakdown.sessions, 2);
    assert.equal(breakdown.complete, true);
  });

  it('يبقى المجموع = مجموع الأجزاء مع كسور عائمة قاسية', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('a', 0.1), model('b', 0.2)]),
      session('claude', [model('a', 0.2), model('c', 0.30000000000000004)]),
    ]);

    const sumOfParts = breakdown.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
    assert.equal(breakdown.totalUsd, sumOfParts);
  });

  it('النموذج بلا سعر يظهر في القائمة بلا مبلغ، ويجعل المجموع جزئياً', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('opus', 1.5), model('mystery-model', null)]),
    ]);

    const mystery = breakdown.perModel.find((row) => row.model === 'mystery-model');
    assert.ok(mystery, 'النموذج غير المسعَّر يجب أن يبقى ظاهراً لا أن يُحذف');
    assert.equal(mystery?.costUsd, null, 'صفر مكان المجهول ممنوع');
    assert.equal(mystery?.requests, 1, 'توكنزه وطلباته تبقى محصاة');

    assert.equal(breakdown.totalUsd, 1.5);
    assert.equal(breakdown.complete, false);
    assert.deepEqual(breakdown.unpricedModels, ['mystery-model']);
  });

  it('نموذج مُسعَّر في محادثة وغير مُسعَّر في أخرى يُفرَّغ صفّه بدل مبلغ جزئي', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('drifting', 3)]),
      session('claude', [model('drifting', null)]),
    ]);

    const row = breakdown.perModel[0];
    assert.equal(row.model, 'drifting');
    assert.equal(row.costUsd, null);
    assert.equal(row.sessions, 2);
    assert.equal(breakdown.totalUsd, 0, 'لا يُنسب للمجموع مبلغ صفٍّ صار مجهولاً');
    assert.equal(breakdown.complete, false);
  });

  it('محادثة جزئية ببند بلا سعر معلن تُبقي الجسم جزئياً ولو سُعِّرت كل نماذجه', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('opus', 2)], { complete: false }),
    ]);

    assert.equal(breakdown.complete, false);
    assert.deepEqual(breakdown.unpricedModels, []);
    assert.equal(breakdown.totalUsd, 2);
  });

  it('محادثة بلا استهلاك داخل النافذة لا تُعدّ محادثةً للدورة', () => {
    const breakdown = buildHarnessBreakdown('codex', [
      session('codex', [model('gpt', 1)]),
      session('codex', []),
    ]);

    assert.equal(breakdown.sessions, 1);
    assert.equal(breakdown.perModel.length, 1);
  });

  it('يرتّب الأغلى أولاً ويضع ما لا سعر له في الذيل', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('cheap', 0.2), model('nameless', null), model('pricey', 9)]),
    ]);

    assert.deepEqual(
      breakdown.perModel.map((row) => row.model),
      ['pricey', 'cheap', 'nameless'],
    );
  });

  it('يجمع التوكنز بالبنود لا كرقم واحد', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('opus', 1, { tokens: totals({ input: 10, cacheRead: 500 }) })]),
      session('claude', [model('opus', 1, { tokens: totals({ input: 5, cacheWrite5m: 7 }) })]),
    ]);

    assert.deepEqual(breakdown.perModel[0].tokens, totals({ input: 15, cacheRead: 500, cacheWrite5m: 7 }));
  });
});

describe('طبقة المحرّك (ADR-037)', () => {
  it('لا تظهر حين لا معلومة محرّك — شجرة من مستويين لا ثلاثة', () => {
    const breakdown = buildHarnessBreakdown('claude', [session('claude', [model('opus', 1)])]);
    assert.equal(breakdown.perModel[0].engineProvider, null);
  });

  it('لا تظهر حين المحرّك هو الجسم نفسه (تكرار لا معلومة)', () => {
    const breakdown = buildHarnessBreakdown('claude', [
      session('claude', [model('opus', 1)], { engineProvider: 'claude' }),
    ]);
    assert.equal(breakdown.perModel[0].engineProvider, null);
  });

  it('تظهر — وتفصل الصفوف — حين يخالف المحرّك جسمه فعلاً', () => {
    const breakdown = buildHarnessBreakdown('opencode', [
      session('opencode', [model('sonnet', 1)], { engineProvider: 'glm' }),
      session('opencode', [model('sonnet', 2)]),
    ]);

    assert.equal(breakdown.perModel.length, 2, 'نفس الاسم خلف محرّكين ليس صفّاً واحداً');
    const engined = breakdown.perModel.find((row) => row.engineProvider === 'glm');
    assert.equal(engined?.costUsd, 1);
    assert.equal(breakdown.totalUsd, 3);
    assert.equal(
      breakdown.totalUsd,
      breakdown.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    );
  });
});

describe('aggregateCostBreakdown', () => {
  it('يقسّم على الأجسام ولا يخلط مجاميعها', () => {
    const harnesses = aggregateCostBreakdown([
      session('claude', [model('opus', 1)]),
      session('codex', [model('gpt-5', 4)]),
      session('claude', [model('opus', 2)]),
    ]);

    assert.deepEqual(
      harnesses.map((harness) => harness.provider),
      ['codex', 'claude'],
      'الأغلى أولاً',
    );
    assert.equal(harnesses[0].totalUsd, 4);
    assert.equal(harnesses[1].totalUsd, 3);
    assert.equal(harnesses[1].sessions, 2);
  });

  it('مجموع كل جسم يساوي مجموع صفوفه (الخاصيّة على كل الأجسام)', () => {
    const harnesses = aggregateCostBreakdown([
      session('claude', [model('opus', 1.1), model('haiku', null)]),
      session('codex', [model('gpt-5', 0.7), model('gpt-5-mini', 0.05)]),
    ]);

    for (const harness of harnesses) {
      const sumOfParts = harness.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0);
      assert.equal(harness.totalUsd, sumOfParts, `اختلّ مجموع ${harness.provider}`);
    }
  });

  it('لا مُدخَلات ⇒ لا أجسام (لا صفّ فارغ يُعرض كأنه اشتراك بلا استهلاك)', () => {
    assert.deepEqual(aggregateCostBreakdown([]), []);
  });
});

describe('breakdownFromSessionCosts — على مخرَج المُسعِّر الحقيقي لا شكل مصطنع', () => {
  it('يتّسق مع calculateSessionCost نموذجاً نموذجاً', () => {
    const costs = [
      calculateSessionCost({
        provider: 'claude',
        perModel: [
          { model: 'claude-sonnet-4-5-20250929', totals: totals({ input: 1000, output: 500 }), requests: 3 },
          { model: 'a-model-with-no-price', totals: totals({ input: 10 }), requests: 1 },
        ],
        subagentRequests: 0,
        skipped: { synthetic: 0, duplicates: 0 },
      }),
      calculateSessionCost({
        provider: 'claude',
        perModel: [
          { model: 'claude-sonnet-4-5-20250929', totals: totals({ input: 2000, output: 1000 }), requests: 4 },
        ],
        subagentRequests: 0,
        skipped: { synthetic: 0, duplicates: 0 },
      }),
    ];

    const breakdown = breakdownFromSessionCosts('claude', costs);
    const sonnet = breakdown.perModel.find((row) => row.model === 'claude-sonnet-4-5-20250929');

    assert.ok(sonnet, 'نموذج بسعر رسمي يجب أن يُسعَّر');
    assert.ok((sonnet?.costUsd ?? 0) > 0);
    assert.equal(sonnet?.requests, 7);
    assert.equal(sonnet?.costUsd, costs[0].perModel[0].costUsd! + costs[1].perModel[0].costUsd!);

    assert.equal(breakdown.complete, false, 'نموذج بلا سعر ⇒ جزئي');
    assert.deepEqual(breakdown.unpricedModels, ['a-model-with-no-price']);
    assert.equal(
      breakdown.totalUsd,
      breakdown.perModel.reduce((sum, row) => sum + (row.costUsd ?? 0), 0),
    );
  });
});
