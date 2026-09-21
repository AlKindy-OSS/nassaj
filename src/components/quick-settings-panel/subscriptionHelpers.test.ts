/**
 * subscriptionHelpers — the rules that keep a subscription card honest.
 *
 * Three of these are the whole reason the logic sits outside the JSX:
 *  • an unpriceable amount must never reach the currency formatter (0.00 reads
 *    as "you spent nothing", which is a different claim from "we don't know");
 *  • a sub-cent amount must not round down to $0.00 for the same reason;
 *  • the harness level must be built ONLY from what the payload actually
 *    carries — absent is not empty, and a group of one is not a hierarchy.
 *
 * RUNNER: node:test — `npx tsx --test src/components/quick-settings-panel/subscriptionHelpers.test.ts`
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  formatCycleStart,
  formatPricesAsOf,
  formatUsd,
  isolateBidi,
  resolveHarnessGroups,
  resolveRowState,
  sumBreakdownUsd,
  type SubscriptionCost,
} from './subscriptionHelpers';

const row = (overrides: Partial<SubscriptionCost> = {}): SubscriptionCost => ({
  provider: 'anthropic',
  displayName: 'Claude',
  plan: 'Max',
  anchorDay: 10,
  cycleStart: '2026-07-10T00:00:00.000Z',
  cycleEnd: '2026-08-10T00:00:00.000Z',
  available: true,
  metered: false,
  totalUsd: 42.5,
  sessions: 7,
  complete: true,
  unpricedModels: [],
  ...overrides,
});

describe('resolveRowState — an unpriceable card never becomes a number', () => {
  it('surfaces the reason instead of an amount when available=false', () => {
    const state = resolveRowState(row({ available: false, reason: 'no token usage persisted', totalUsd: 0 }));
    assert.deepEqual(state, { kind: 'unavailable', reason: 'no token usage persisted' });
  });

  it('keeps reason=null (not undefined) when the server omitted it', () => {
    assert.deepEqual(resolveRowState(row({ available: false })), { kind: 'unavailable', reason: null });
  });

  it('treats a non-finite total as unavailable — "$NaN" is not a rendering, it is a lie', () => {
    assert.equal(resolveRowState(row({ totalUsd: Number.NaN })).kind, 'unavailable');
    assert.equal(resolveRowState(row({ totalUsd: Number.POSITIVE_INFINITY })).kind, 'unavailable');
    // A null slipping through the API boundary coerces to a very believable 0.00.
    assert.equal(resolveRowState(row({ totalUsd: null as unknown as number })).kind, 'unavailable');
  });

  it('carries metered through so the card can say API-equivalent vs billed', () => {
    assert.deepEqual(resolveRowState(row({ metered: false })), { kind: 'amount', metered: false, partial: false });
    assert.deepEqual(resolveRowState(row({ metered: true })), { kind: 'amount', metered: true, partial: false });
  });

  it('marks complete=false as partial', () => {
    const state = resolveRowState(row({ complete: false, unpricedModels: ['some-new-model'] }));
    assert.deepEqual(state, { kind: 'amount', metered: false, partial: true });
  });

  it('a zero total that IS known stays an amount — 0.00 is only forbidden as a stand-in for unknown', () => {
    assert.deepEqual(resolveRowState(row({ totalUsd: 0 })), { kind: 'amount', metered: false, partial: false });
  });
});

describe('resolveHarnessGroups — subscription → harness → model', () => {
  it('yields nothing when the payload carries no `byHarness` (absent ≠ "nothing ran")', () => {
    // An older server sends no breakdown at all; the card must then draw none,
    // not an empty group that would read as "this vendor was never used".
    assert.deepEqual(resolveHarnessGroups(row()), []);
    assert.deepEqual(resolveHarnessGroups(row({ byHarness: undefined })), []);
    assert.deepEqual(
      resolveHarnessGroups(row({ byHarness: {} as unknown as SubscriptionCost['byHarness'] })),
      [],
    );
  });

  it('groups one vendor across the harnesses it was reached through — the bug this replaces', () => {
    // MEASURED on this machine: GLM ran through OpenCode (11 sessions) and its
    // own CLI. The old panel drew a "GLM — Not available" card while GLM's
    // spend sat inside the OpenCode card. One vendor, two harnesses, one card.
    const groups = resolveHarnessGroups(
      row({
        provider: 'glm',
        displayName: 'GLM (z.ai)',
        totalUsd: 7,
        byHarness: [
          {
            harness: 'glm-cli',
            displayName: 'GLM CLI',
            totalUsd: 2,
            perModel: [{ model: 'glm-5.2', costUsd: 2, requests: 4 }],
          },
          {
            harness: 'opencode',
            displayName: 'OpenCode',
            totalUsd: 5,
            perModel: [{ model: 'glm/glm-5.2', costUsd: 5, requests: 11 }],
          },
        ],
      }),
    );

    assert.deepEqual(groups.map((group) => group.harness), ['opencode', 'glm-cli'], 'dearest harness first');
    assert.deepEqual(groups.map((group) => group.totalUsd), [5, 2]);
    // The same model reached through two harnesses reads as ONE model: the
    // OpenCode DB spells the vendor into the id ("glm/glm-5.2") and the card
    // already says GLM.
    assert.deepEqual(groups.map((group) => group.models[0].model), ['glm-5.2', 'glm-5.2']);
    assert.equal(groups[0].models[0].modelId, 'glm/glm-5.2', 'the raw id survives for the key and the tooltip');
  });

  it('strips the vendor prefix only on an EXACT vendor match', () => {
    const groups = resolveHarnessGroups(
      row({
        provider: 'opencode-zen',
        byHarness: [
          {
            harness: 'opencode',
            totalUsd: 1,
            perModel: [
              { model: 'opencode/big-pickle', costUsd: 0.6, requests: 1 },
              { model: 'opencode-zen/deepseek-v4-flash-free', costUsd: 0.4, requests: 1 },
            ],
          },
        ],
      }),
    );

    // "opencode" (the harness) is NOT "opencode-zen" (the vendor this card is),
    // so that prefix is information and survives; the exact-match one is the
    // card's own name printed twice and goes.
    assert.deepEqual(
      groups[0].models.map((entry) => entry.model),
      ['opencode/big-pickle', 'deepseek-v4-flash-free'],
    );
  });

  it('falls back to the harness key when the server sent no display name', () => {
    const groups = resolveHarnessGroups(
      row({ byHarness: [{ harness: 'claude-code', totalUsd: 1, perModel: [] }] }),
    );
    assert.equal(groups[0].displayName, 'claude-code');
  });

  it('lists an unpriced model with NO amount — and that is why the total is partial', () => {
    const subscription = row({
      totalUsd: 4,
      complete: false,
      unpricedModels: ['mystery-model'],
      byHarness: [
        {
          harness: 'claude-code',
          totalUsd: 4,
          perModel: [
            { model: 'claude-opus-5', costUsd: 4, requests: 12 },
            { model: 'mystery-model', costUsd: null, requests: 2 },
          ],
        },
      ],
    });

    const models = resolveHarnessGroups(subscription)[0].models;
    const mystery = models.find((entry) => entry.model === 'mystery-model');
    assert.ok(mystery, 'an unpriced model must stay visible');
    assert.equal(mystery?.costUsd, null);

    // The priced lines still add up to the advertised total: the unknown line
    // is excluded from the money, not folded into it as a zero.
    assert.equal(sumBreakdownUsd(models), 4);
    const state = resolveRowState(subscription);
    assert.equal(state.kind === 'amount' && state.partial, true);
  });

  it('the harness total equals the sum of its parts', () => {
    const groups = resolveHarnessGroups(
      row({
        totalUsd: 4.5,
        byHarness: [
          {
            harness: 'claude-code',
            totalUsd: 4.5,
            perModel: [
              { model: 'claude-opus-5', costUsd: 4, requests: 12, sessions: 2 },
              { model: 'claude-sonnet-4-6', costUsd: 0.5, requests: 3, sessions: 1 },
            ],
          },
        ],
      }),
    );
    assert.ok(Math.abs(sumBreakdownUsd(groups[0].models) - (groups[0].totalUsd as number)) < 1e-9);
  });

  it('demotes non-finite amounts to unpriced instead of printing $NaN', () => {
    const groups = resolveHarnessGroups(
      row({
        byHarness: [
          {
            harness: 'codex',
            totalUsd: Number.NaN,
            perModel: [{ model: 'broken', costUsd: Number.NaN, requests: 1 }],
          },
        ],
      }),
    );
    assert.equal(groups[0].totalUsd, null, 'a harness with no printable total still names itself');
    assert.equal(groups[0].models[0].costUsd, null);
  });

  it('orders models dearest first and keeps unpriced ones last', () => {
    const groups = resolveHarnessGroups(
      row({
        byHarness: [
          {
            harness: 'opencode',
            totalUsd: 9.2,
            perModel: [
              { model: 'cheap', costUsd: 0.2, requests: 1 },
              { model: 'nameless', costUsd: null, requests: 1 },
              { model: 'pricey', costUsd: 9, requests: 1 },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(groups[0].models.map((entry) => entry.model), ['pricey', 'cheap', 'nameless']);
  });

  it('sorts harnesses without a printable total after those that have one', () => {
    const groups = resolveHarnessGroups(
      row({
        byHarness: [
          { harness: 'a-no-total', perModel: [{ model: 'm', costUsd: null }] },
          { harness: 'z-with-total', totalUsd: 0.5, perModel: [{ model: 'n', costUsd: 0.5 }] },
        ],
      }),
    );
    assert.deepEqual(groups.map((group) => group.harness), ['z-with-total', 'a-no-total']);
  });

  it('drops entries that carry nothing at all, and keeps the ones that do', () => {
    const groups = resolveHarnessGroups(
      row({
        byHarness: [
          null as unknown as { harness: string },
          { harness: '   ' },
          { harness: 'empty' }, // no models, no total, no sessions — nothing to say
          { harness: 'ran-but-unpriced', sessions: 3 },
          { harness: 'priced', totalUsd: 1 },
        ],
      }),
    );
    assert.deepEqual(groups.map((group) => group.harness), ['priced', 'ran-but-unpriced']);
  });

  it('drops model entries with no usable id', () => {
    const groups = resolveHarnessGroups(
      row({
        byHarness: [
          {
            harness: 'codex',
            totalUsd: 1,
            perModel: [
              { model: 'gpt-5.6-sol', costUsd: 1 },
              { model: '   ', costUsd: 0.5 },
              null as unknown as { model: string; costUsd: number },
              { costUsd: 0.5 } as unknown as { model: string; costUsd: number },
            ],
          },
        ],
      }),
    );
    assert.deepEqual(groups[0].models.map((entry) => entry.model), ['gpt-5.6-sol']);
  });
});

describe('isolateBidi — a Latin name interpolated into an Arabic sentence', () => {
  it('wraps the value in FSI … PDI (the <bdi> a translation string cannot contain)', () => {
    assert.equal(isolateBidi('opencode'), '\u2068opencode\u2069');
  });
});

describe('formatUsd', () => {
  it('formats normal amounts with two fraction digits', () => {
    assert.equal(formatUsd(42.5, 'en'), '$42.50');
    assert.equal(formatUsd(0, 'en'), '$0.00');
  });

  it('keeps four digits below a cent so real usage never renders as $0.00', () => {
    assert.equal(formatUsd(0.0034, 'en'), '$0.0034');
    assert.equal(formatUsd(0.009, 'en'), '$0.0090');
    // At exactly one cent the two-digit form is already truthful.
    assert.equal(formatUsd(0.01, 'en'), '$0.01');
  });

  it('shapes for the Arabic locale without losing the digits', () => {
    const arabic = formatUsd(42.5, 'ar');
    assert.ok(arabic.includes('42.5'), `expected Western digits in "${arabic}"`);
    assert.ok(!arabic.includes('NaN'));
  });

  it('falls back to a plain dollar amount when the locale tag is unusable', () => {
    assert.equal(formatUsd(42.5, 'not a locale'), '$42.50');
  });
});

describe('formatCycleStart', () => {
  // Noon UTC on purpose: cycleStart is a real instant and is formatted in the
  // viewer's zone, so a midnight fixture would flip a day in half the world and
  // pin the test to the runner's TZ instead of to the behaviour.
  it('renders day + month, no year', () => {
    assert.equal(formatCycleStart('2026-07-10T12:00:00.000Z', 'en'), 'July 10');
  });

  it('returns null for an unusable timestamp so the caller can omit the line', () => {
    assert.equal(formatCycleStart('not-a-date', 'en'), null);
    assert.equal(formatCycleStart('', 'en'), null);
  });

  it('degrades to the date part rather than dropping the window on a bad locale', () => {
    assert.equal(formatCycleStart('2026-07-10T12:00:00.000Z', 'not a locale'), '2026-07-10');
  });
});

describe('formatPricesAsOf — the date-only stamp must not drift a day', () => {
  // Run this file under TZ=America/Los_Angeles to see the guard bite: a
  // date-only string parses as UTC midnight, so local formatting renders the
  // 27th there. The stamp must always name the day it was given.
  it('shows the day it names, whatever zone the viewer is in', () => {
    assert.equal(formatPricesAsOf('2026-07-28', 'en'), 'Jul 28, 2026');
  });

  it('leaves a full timestamp in the viewer\'s zone — it is a real instant', () => {
    const formatted = formatPricesAsOf('2026-07-28T12:00:00.000Z', 'en');
    assert.ok(formatted && formatted.includes('2026'), `unexpected: ${formatted}`);
  });

  it('returns null for an unusable stamp', () => {
    assert.equal(formatPricesAsOf('nope', 'en'), null);
  });
});
