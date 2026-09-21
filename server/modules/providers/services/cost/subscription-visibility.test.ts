/**
 * subscription-visibility.test.ts — T-1098.
 *
 * The defect under test is a LEAK, so the cases are written from the attacker's
 * side of it: a plain member asks for the subscription card and must not be able
 * to recover the team's spend from the payload — not from `totalUsd`, not from a
 * per-harness breakdown, not from a balance. Asserting only that `available` went
 * false would pass while the number still rode along in the body.
 *
 * Runner: node:test + node:assert/strict via
 *   npx tsx --tsconfig server/tsconfig.json --test <this file>
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { vendorHarnesses } from './model-vendor.js';
import {
  applySubscriptionAmountVisibility,
  SHARED_AMOUNT_RESTRICTED_REASON,
  type AmountBearingSubscriptionRow,
} from './subscription-visibility.js';

/** The live policy at the time of the decision: 4 shared, the rest isolated. */
const LIVE_POLICY: Record<string, 'shared' | 'isolated'> = {
  claude: 'isolated',
  gemini: 'isolated',
  kimi: 'isolated',
  deepseek: 'isolated',
  glm: 'isolated',
  codex: 'shared',
  agy: 'shared',
  cursor: 'shared',
  opencode: 'shared',
};
const isProviderIsolated = (p: string): boolean => LIVE_POLICY[p] === 'isolated';
// The REAL vendor→harness expansion, not a stub: the bug this suite now guards
// lived precisely in the gap between the two key spaces, so faking the mapping
// would reopen it.
const deps = { isProviderIsolated, vendorHarnesses };

function row(provider: string, over: Partial<AmountBearingSubscriptionRow> = {}): AmountBearingSubscriptionRow {
  return {
    provider,
    available: true,
    totalUsd: 137.42,
    sessions: 19,
    unpricedModels: ['some-model'],
    balanceUsd: 12.5,
    byHarness: [{ harness: 'opencode', costUsd: 100 }],
    assumedModels: ['guessed-model'],
    ...over,
  };
}

/** Every place a dollar figure could hide in one row. */
function leakedFigures(r: AmountBearingSubscriptionRow): unknown[] {
  return [r.totalUsd, r.balanceUsd, r.byHarness, r.assumedModels].filter(
    (v) => v !== 0 && v !== null && v !== undefined,
  );
}

describe('applySubscriptionAmountVisibility — owner/admin see everything', () => {
  for (const role of ['owner', 'admin']) {
    it(`${role}: rows pass through untouched`, () => {
      const input = [row('openai'), row('anthropic'), row('google')];
      const out = applySubscriptionAmountVisibility(input, role, deps);
      assert.deepEqual(out, input, `${role} must see the team total unmodified`);
    });
  }
});

describe('applySubscriptionAmountVisibility — a member cannot read the team total', () => {
  it('redacts every vendor fed by a SHARED harness', () => {
    // openai←codex, opencode-zen←opencode, google←gemini+antigravity+agy.
    for (const vendor of ['openai', 'opencode-zen', 'google']) {
      const [out] = applySubscriptionAmountVisibility([row(vendor)], 'user', deps);
      assert.equal(out.available, false, `${vendor} must not be marked available`);
      assert.equal(out.reason, SHARED_AMOUNT_RESTRICTED_REASON);
      assert.deepEqual(
        leakedFigures(out),
        [],
        `${vendor}: no dollar figure may survive anywhere in the row`,
      );
      assert.equal(out.sessions, 0, `${vendor}: activity count is a signal too`);
    }
  });

  it('leaves vendors whose harnesses are ALL isolated — the reader is the holder', () => {
    // The regression that live verification caught: `anthropic` and `moonshot`
    // are vendor keys absent from the sharing policy, so a direct key lookup
    // redacted a member's OWN Claude/Kimi spend.
    for (const vendor of ['anthropic', 'moonshot', 'glm', 'deepseek']) {
      const input = row(vendor);
      const [out] = applySubscriptionAmountVisibility([input], 'user', deps);
      assert.deepEqual(out, input, `${vendor}: the member's own total must still show`);
    }
  });

  it('redacts `google` because one of its harnesses is shared, though gemini is isolated', () => {
    // The many-to-one case stated explicitly: a mixed row must follow its most
    // permissive contributor, not its most restrictive.
    assert.ok(vendorHarnesses('google').includes('gemini'), 'gemini feeds the google row');
    assert.ok(vendorHarnesses('google').includes('agy'), 'agy feeds it too');
    const [out] = applySubscriptionAmountVisibility([row('google')], 'user', deps);
    assert.equal(out.available, false, 'one shared contributor must redact the whole row');
  });

  it('redacts a shared row while preserving its identity/cycle fields', () => {
    // The card still has to render the row — it just may not show a figure.
    const input = { ...row('openai'), displayName: 'OpenAI', anchorDay: 11 } as AmountBearingSubscriptionRow & {
      displayName: string;
      anchorDay: number;
    };
    const [out] = applySubscriptionAmountVisibility([input], 'user', deps);
    assert.equal(out.displayName, 'OpenAI');
    assert.equal(out.anchorDay, 11);
    assert.equal(out.provider, 'openai');
  });

  it('does not mutate the caller’s input rows', () => {
    const input = row('openai');
    applySubscriptionAmountVisibility([input], 'user', deps);
    assert.equal(input.totalUsd, 137.42, 'redaction must be a copy, not an in-place edit');
    assert.equal(input.available, true);
  });
});

describe('applySubscriptionAmountVisibility — fail-closed on anything unclear', () => {
  it('treats an unknown role as unprivileged', () => {
    for (const role of ['user', 'viewer', 'ADMIN', 'Owner', '', 'root']) {
      const [out] = applySubscriptionAmountVisibility([row('openai')], role, deps);
      assert.equal(out.available, false, `role ${JSON.stringify(role)} must not unlock the amount`);
    }
  });

  it('treats a missing role as unprivileged', () => {
    for (const role of [null, undefined]) {
      const [out] = applySubscriptionAmountVisibility([row('openai')], role, deps);
      assert.equal(out.available, false, 'an unresolved role must redact, never leak');
    }
  });

  it('treats `nous`/hermes as shared — its harness is absent from the policy', () => {
    assert.deepEqual(vendorHarnesses('nous'), ['hermes']);
    const [out] = applySubscriptionAmountVisibility([row('nous')], 'user', deps);
    assert.equal(out.available, false, 'unknown sharing must fail closed (T-1201)');
    assert.deepEqual(leakedFigures(out), []);
  });

  it('redacts an entirely unrecognised row key', () => {
    const [out] = applySubscriptionAmountVisibility([row('unknown')], 'user', deps);
    assert.equal(out.available, false, 'a key with no known harness must not be trusted');
  });

  it('expands the vendor key rather than looking it up in the policy directly', () => {
    // Guards the exact defect live verification caught: a direct lookup of
    // `anthropic` finds nothing and wrongly redacts the member's own spend.
    const seen: string[] = [];
    applySubscriptionAmountVisibility([row('anthropic')], 'user', {
      isProviderIsolated: (p) => {
        seen.push(p);
        return isProviderIsolated(p);
      },
      vendorHarnesses,
    });
    assert.deepEqual(seen, ['claude'], 'anthropic must be resolved to its harness, not queried raw');
  });

  it('returns a new array and tolerates an empty set', () => {
    const input: AmountBearingSubscriptionRow[] = [];
    const out = applySubscriptionAmountVisibility(input, 'owner', deps);
    assert.deepEqual(out, []);
    assert.notEqual(out, input, 'must not hand back the caller’s array identity');
  });
});
