/**
 * company-credentials.unified.test.ts — ADR-200 S6, the company route around
 * the unified fan-out:
 *   - flag OFF restores the T-1201 behaviour (dispatcher per slot, the live
 *     subscription skip, `written`), and writes no unified record;
 *   - flag OFF, the legacy company delete also removes the member's `vendor:*`
 *     record (§3), so the two models cannot diverge;
 *   - flag ON, Save and Delete go to the fan-out with the company's slots and
 *     the explicit confirms.
 * Real AES store inside the hermetic sandbox (B-1544); the dispatcher, the auth
 * probe and the fan-out runtime are module mocks.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import { after, beforeEach, mock, test } from 'node:test';
import { pathToFileURL } from 'node:url';

// B-1544: must stay the first app-side import; it sandboxes HOME so keys.json never lands in the real one.
import { removeSandbox } from '../tests/helpers/hermetic-sandbox.js';

process.env.NASSAJ_PROVIDER_SECRETS_KEY = Buffer.alloc(32, 5).toString('base64');

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const KEY = 'sk' + '-ant-api03-COMPANY-UNIFIED-0001';

let dispatched: string[] = [];
let subscribed = new Set<string>();
let fanoutCalls: Array<{ op: string; vendorId: string; options: Record<string, unknown> }> = [];

mock.module(url('./provider-credentials.service.js'), {
  namedExports: {
    providerCredentialsService: {
      requiresElevatedRole: () => false,
      setKey: async (_userId: unknown, provider: string, _key: string, target?: string) => {
        dispatched.push(`set:${provider}:${target ?? '-'}`);
        return { provider, configured: true };
      },
      deleteKey: async (_userId: unknown, provider: string, target?: string) => {
        dispatched.push(`delete:${provider}:${target ?? '-'}`);
        return { provider, configured: false };
      },
      getStatus: async (_userId: unknown, provider: string) => ({ provider, configured: false }),
    },
  },
});

mock.module(url('./provider-auth.service.js'), {
  namedExports: {
    providerAuthService: {
      getProviderAuthStatus: async (provider: string) => ({
        installed: true, provider, authenticated: subscribed.has(provider), email: null,
        method: subscribed.has(provider) ? 'oauth_token' : null,
        authMode: subscribed.has(provider) ? 'subscription_oauth' : null,
      }),
    },
  },
});

mock.module(url('./vendor-key-fanout.runtime.js'), {
  namedExports: {
    vendorKeyFanoutService: {
      save: async (_userId: unknown, vendorId: string, _key: string, options: Record<string, unknown>) => {
        fanoutCalls.push({ op: 'save', vendorId, options });
        return (options.slots as Array<Record<string, string>>).map((slot) => ({ ...slot, outcome: 'linked' }));
      },
      remove: async (_userId: unknown, vendorId: string, options: Record<string, unknown>) => {
        fanoutCalls.push({ op: 'remove', vendorId, options });
        return (options.slots as Array<Record<string, string>>).map((slot) => ({ ...slot, outcome: 'removed' }));
      },
    },
  },
});

const store = await import('@/services/isolation/provider-secrets-store.js');
const { companyCredentialsService } = await import('./company-credentials.service.js');
store._resetProviderSecretsServerKeyCache();

after(() => removeSandbox());

beforeEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  dispatched = [];
  subscribed = new Set();
  fanoutCalls = [];
});

/** A `vendor:anthropic` record left behind by a flag-on period. */
function seedCanonical(userId: string): void {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  store.setCanonicalVendorKey(userId, 'anthropic', KEY);
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
}

test('flag OFF: save is the T-1201 path exactly and writes no unified record', async () => {
  subscribed = new Set(['claude']);
  const result = await companyCredentialsService.setKey('41', 'anthropic', KEY, { isElevated: false });
  assert.deepEqual(result.slots.map((slot) => slot.outcome), ['skipped_subscription', 'written']);
  assert.deepEqual(dispatched, ['set:opencode:anthropic']);
  assert.equal(fanoutCalls.length, 0, 'the fan-out is never loaded with the flag off');
  assert.equal(store.getCanonicalVendorKey('41', 'anthropic'), null);
  assert.equal(store.readVendorLedgerState('41', 'anthropic').state, 'absent');
});

test('flag OFF: the legacy company delete also removes the vendor:* record', async () => {
  seedCanonical('42');
  const result = await companyCredentialsService.deleteKey('42', 'anthropic', { isElevated: false });
  assert.deepEqual(result.slots.map((slot) => slot.outcome), ['written', 'written']);
  assert.deepEqual(dispatched, ['delete:claude:-', 'delete:opencode:anthropic']);
  assert.equal(store.getCanonicalVendorKey('42', 'anthropic'), null);
  assert.equal(fanoutCalls.length, 0);
});

test('flag OFF: a single-slot legacy delete still removes the vendor:* record', async () => {
  seedCanonical('43');
  await companyCredentialsService.deleteKey('43', 'anthropic', { isElevated: false, vendorIds: ['anthropic-opencode'] });
  assert.equal(store.getCanonicalVendorKey('43', 'anthropic'), null);
});

test('flag OFF: a company without a vendor:* record deletes exactly as before', async () => {
  const result = await companyCredentialsService.deleteKey('44', 'zai', { isElevated: false });
  assert.deepEqual(result.slots.map((slot) => `${slot.vendorId}:${slot.outcome}`), ['zai:written', 'zai-opencode:written']);
});

test('flag ON: save and delete go to the fan-out with the slots and the confirms', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  const saved = await companyCredentialsService.setKey('45', 'anthropic', ` ${KEY} `, {
    isElevated: true, replaceForeignKey: true, vendorIds: ['anthropic-opencode'],
  });
  assert.equal(saved.configured, true);
  assert.equal(fanoutCalls[0].op, 'save');
  assert.deepEqual(fanoutCalls[0].options.slots, [{ vendorId: 'anthropic-opencode', provider: 'opencode', target: 'anthropic' }]);
  assert.equal(fanoutCalls[0].options.replaceForeignKey, true);
  assert.deepEqual(dispatched, [], 'the T-1201 dispatcher loop is not used in-flag');

  const removed = await companyCredentialsService.deleteKey('45', 'anthropic', { isElevated: true, removeForeignKey: true });
  assert.equal(fanoutCalls[1].op, 'remove');
  assert.equal(fanoutCalls[1].options.removeForeignKey, true);
  assert.deepEqual(removed.slots.map((slot) => slot.outcome), ['removed', 'removed']);
  assert.equal(JSON.stringify(fanoutCalls).includes(KEY), false, 'the key never reaches the options');
});

test('flag ON without a member keeps the T-1201 path', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  await companyCredentialsService.setKey(null, 'zai', KEY, { isElevated: true });
  assert.equal(fanoutCalls.length, 0);
  assert.deepEqual(dispatched, ['set:glm:-', 'set:opencode:glm']);
});

test('G2 flag ON: a per-slot delete is refused (409 VENDOR_DELETE_IS_VENDOR_WIDE); all slots go through', async () => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  await assert.rejects(
    companyCredentialsService.deleteKey('46', 'anthropic', { isElevated: true, vendorIds: ['anthropic-opencode'] }),
    (error: unknown) => {
      const err = error as { code?: string; statusCode?: number };
      return err.code === 'VENDOR_DELETE_IS_VENDOR_WIDE' && err.statusCode === 409;
    },
  );
  assert.equal(fanoutCalls.length, 0, 'nothing was removed');
  assert.deepEqual(dispatched, []);

  await companyCredentialsService.deleteKey('46', 'anthropic', { isElevated: true, vendorIds: ['anthropic', 'anthropic-opencode'] });
  assert.equal(fanoutCalls[0]?.op, 'remove', 'naming every slot is the vendor-wide delete');
});

test('ADR-200 S9: getStatus carries projections in-flag only, from the caller\'s own ledger', async () => {
  const fingerprint = (() => {
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
    const fp = store.projectionFingerprint(KEY, store.PROJECTION_FINGERPRINT_KEY_VERSION);
    store.setVendorLedger('51', 'moonshot', { v: 1, entries: [{
      harness: 'opencode', target: 'moonshotai', fingerprint: fp, keyVersion: store.PROJECTION_FINGERPRINT_KEY_VERSION,
      state: 'stale', origin: 'fanout', updatedAt: new Date().toISOString(),
    }] });
    return fp;
  })();
  const on = await companyCredentialsService.getStatus('51', 'moonshot');
  assert.deepEqual(on.projections, [{ vendorId: 'moonshot', provider: 'opencode', target: 'moonshotai', state: 'stale' }]);
  assert.equal(JSON.stringify(on).includes(fingerprint), false, 'no fingerprint in the status');
  assert.equal(JSON.stringify(on).includes(KEY), false);
  const other = await companyCredentialsService.getStatus('52', 'moonshot');
  assert.equal(other.projections?.some((p) => p.state === 'stale'), false, 'another member sees none of it');
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
  assert.equal('projections' in await companyCredentialsService.getStatus('51', 'moonshot'), false);
});
