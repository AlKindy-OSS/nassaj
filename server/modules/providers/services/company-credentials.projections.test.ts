/**
 * company-credentials.projections.test.ts — ADR-200 S9, the read-only
 * per-harness state of a company key (`projections` on the company status GET).
 * Pure derivation over fake reads: ledger mapping, scope and link-mode
 * fallbacks, AES-only slots, extra ledger entries, and that nothing but the
 * four documented fields ever leaves (no fingerprint).
 */

import assert from 'node:assert/strict';
import { after, test } from 'node:test';

// B-1544: must stay the first app-side import; it sandboxes HOME before any store module loads.
import { removeSandbox } from '../tests/helpers/hermetic-sandbox.js';

import type { LedgerEntry } from './vendor-key-migration.service.js';

const { deriveCompanyProjections } = await import('./company-credentials.projections.js');
type ProjectionReadDeps = import('./company-credentials.projections.js').ProjectionReadDeps;
type ProjectionSlot = import('./company-credentials.projections.js').ProjectionSlot;

after(() => removeSandbox());

const FP = 'f'.repeat(64);

function entry(harness: LedgerEntry['harness'], target: string | null, state: LedgerEntry['state'], origin: LedgerEntry['origin'] = 'fanout'): LedgerEntry {
  return { harness, target, fingerprint: FP, keyVersion: 1, state, origin, updatedAt: '2026-10-09T00:00:00.000Z' };
}

type Fake = {
  ledger?: Record<string, readonly LedgerEntry[] | null>;
  shared?: string[];
  modes?: Record<string, 'subscription' | 'api_key' | null | 'unreadable'>;
  ledgerReads?: unknown[];
};

function deps(fake: Fake): ProjectionReadDeps {
  return {
    readLedger: (userId, vendorId) => {
      fake.ledgerReads?.push(userId);
      return fake.ledger?.[`${userId}:${vendorId}`] ?? [];
    },
    isOwnScope: (provider) => !(fake.shared ?? []).includes(provider),
    readLinkMode: (_userId, harness) => (fake.modes && harness in fake.modes ? fake.modes[harness] : 'api_key'),
  };
}

const ANTHROPIC: ProjectionSlot[] = [
  { vendorId: 'anthropic', provider: 'claude', configured: true },
  { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', configured: true },
];

test('ledger states map one to one; synced is linked, an adopted synced entry is adopted', () => {
  for (const [state, origin, expected] of [
    ['synced', 'fanout', 'linked'], ['synced', 'adopted', 'adopted'], ['stale', 'fanout', 'stale'],
    ['failed', 'adopted', 'failed'], ['tombstone', 'fanout', 'tombstone'],
  ] as const) {
    const out = deriveCompanyProjections(deps({ ledger: { '7:anthropic': [entry('claude', null, state, origin)] } }), '7', 'anthropic', ANTHROPIC);
    assert.deepEqual(out[0], { vendorId: 'anthropic', provider: 'claude', state: expected });
  }
});

test('a shared tree is shared_scope_refused before the ledger is consulted', () => {
  const fake: Fake = { shared: ['opencode'], ledger: { '7:anthropic': [entry('opencode', 'anthropic', 'synced')] } };
  const out = deriveCompanyProjections(deps(fake), '7', 'anthropic', ANTHROPIC);
  assert.deepEqual(out.find((p) => p.provider === 'opencode'),
    { vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic', state: 'shared_scope_refused' });
});

test('no ledger entry: link mode decides for Claude/Codex; opencode is omitted', () => {
  const subscription = deriveCompanyProjections(deps({ modes: { claude: 'subscription' } }), '7', 'anthropic', ANTHROPIC);
  assert.deepEqual(subscription, [{ vendorId: 'anthropic', provider: 'claude', state: 'kept_on_subscription' }]);
  const unset = deriveCompanyProjections(deps({ modes: { claude: null } }), '7', 'anthropic', ANTHROPIC);
  assert.equal(unset[0].state, 'mode_unset');
  assert.deepEqual(deriveCompanyProjections(deps({ modes: { claude: 'api_key' } }), '7', 'anthropic', ANTHROPIC), []);
  assert.deepEqual(deriveCompanyProjections(deps({ modes: { claude: 'unreadable' } }), '7', 'anthropic', ANTHROPIC), []);
});

test('an AES-only slot is linked only when configured', () => {
  const slots: ProjectionSlot[] = [{ vendorId: 'moonshot', provider: 'kimi', configured: true }];
  assert.deepEqual(deriveCompanyProjections(deps({}), '7', 'moonshot', slots), [{ vendorId: 'moonshot', provider: 'kimi', state: 'linked' }]);
  assert.deepEqual(deriveCompanyProjections(deps({}), '7', 'moonshot', [{ ...slots[0], configured: false }]), []);
});

test('a ledger entry with no matching slot is kept under the company id', () => {
  const fake: Fake = { ledger: { '7:moonshot': [entry('claude', null, 'tombstone')] } };
  const out = deriveCompanyProjections(deps(fake), '7', 'moonshot', [{ vendorId: 'moonshot', provider: 'kimi', configured: false }]);
  assert.deepEqual(out, [{ vendorId: 'moonshot', provider: 'claude', state: 'tombstone' }]);
});

test('an unreadable ledger falls back to the live classification, never fails', () => {
  const fake: Fake = { ledger: { '7:anthropic': null }, modes: { claude: 'subscription' } };
  assert.equal(deriveCompanyProjections(deps(fake), '7', 'anthropic', ANTHROPIC)[0].state, 'kept_on_subscription');
});

test('member isolation: only the caller\'s own ledger is read; no member reads none', () => {
  const fake: Fake = { ledger: { '7:anthropic': [entry('claude', null, 'synced')] }, modes: { claude: null }, ledgerReads: [] };
  assert.equal(deriveCompanyProjections(deps(fake), '8', 'anthropic', ANTHROPIC)[0].state, 'mode_unset');
  assert.equal(deriveCompanyProjections(deps(fake), null, 'anthropic', ANTHROPIC)[0].state, 'mode_unset');
  assert.deepEqual(fake.ledgerReads, ['8']);
});

test('a projection carries only vendorId, provider, target and state — never a fingerprint', () => {
  const fake: Fake = { ledger: { '7:anthropic': [entry('claude', null, 'synced'), entry('opencode', 'anthropic', 'failed')] } };
  const out = deriveCompanyProjections(deps(fake), '7', 'anthropic', ANTHROPIC);
  for (const projection of out) {
    assert.deepEqual(Object.keys(projection).filter((k) => !['vendorId', 'provider', 'target', 'state'].includes(k)), []);
  }
  assert.equal(JSON.stringify(out).includes(FP), false);
});
