/**
 * company-credentials.service.test.ts — T-1159.
 *
 * The three rules of the one-key-per-company fan-out, each of which is a
 * money- or access-shaped promise rather than a formatting detail:
 *
 *  1. ONE PASTE REACHES EVERY SLOT of the company, each through its own
 *     harness's native surface (the dispatcher decides that; here we assert the
 *     dispatcher is CALLED once per slot, with that slot's provider+target).
 *  2. A SUBSCRIBED HARNESS IS NEVER OVERWRITTEN by default. Claude Code reads
 *     settings.json before its OAuth record, so writing a key into a subscribed
 *     harness silently downgrades a Max plan to metered API billing. The
 *     override exists but must be asked for.
 *  3. A HALF-SUCCESS NEVER REPORTS SUCCESS: one slot's failure or 403 is
 *     reported per-slot and does not cancel the remaining slots.
 *  4. THE SELECTION ONLY NARROWS (T-1201). The tab now offers one field and a
 *     checkbox per place, so the call names the slots it ticked. That list is a
 *     filter over the company named in the path — it cannot reach another
 *     company's slot, cannot restore a slot the role gate refuses, and cannot
 *     write a subscribed harness without also asking for the override. Every
 *     one of those is asserted below, because each is exactly the shape a
 *     request body would take if it were trying to widen its own reach.
 *
 * Framework: node:test module mocking (--experimental-test-module-mocks), so
 * the dispatcher and the auth probe are stubs — this suite touches no disk, no
 * encrypted store, and no real credential.
 */

import assert from 'node:assert/strict';
import path from 'node:path';
import test, { beforeEach, mock } from 'node:test';
import { pathToFileURL } from 'node:url';

const url = (spec: string) => pathToFileURL(path.resolve(import.meta.dirname, spec)).href;

const KEY = 'sk-company-secret-DO-NOT-LEAK';

// ADR-200 S10: the unified model is ON by default. This suite pins the legacy
// T-1159/T-1201 fan-out, so it runs with the kill switch.
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';

/** Every setKey the service dispatched, in order. */
let setCalls: Array<{ provider: string; target?: string; apiKey: string; auditContext?: Record<string, unknown> }> = [];
/** Providers the stub dispatcher should refuse with a throw. */
let failingProviders = new Set<string>();
/** Providers the stub auth probe reports as signed in by subscription. */
let subscribedProviders = new Set<string>();

mock.module(url('./provider-credentials.service.js'), {
  namedExports: {
    providerCredentialsService: {
      setKey: async (
        _userId: unknown,
        provider: string,
        apiKey: string,
        target?: string,
        _principal?: unknown,
        auditContext?: Record<string, unknown>,
      ) => {
        if (failingProviders.has(provider)) {
          throw new Error(`writer refused ${provider}`);
        }
        setCalls.push({ provider, target, apiKey, auditContext });
        return { provider, configured: true };
      },
      deleteKey: async (_userId: unknown, provider: string) => ({ provider, configured: false }),
      getStatus: async (_userId: unknown, provider: string) => ({ provider, configured: false }),
    },
  },
});

mock.module(url('./provider-auth.service.js'), {
  namedExports: {
    providerAuthService: {
      getProviderAuthStatus: async (provider: string) => ({
        installed: true,
        provider,
        authenticated: subscribedProviders.has(provider),
        email: null,
        method: subscribedProviders.has(provider) ? 'oauth_token' : null,
        authMode: subscribedProviders.has(provider) ? 'subscription_oauth' : null,
      }),
    },
  },
});

const { companyCredentialsService } = await import('./company-credentials.service.js');

beforeEach(() => {
  setCalls = [];
  failingProviders = new Set();
  subscribedProviders = new Set();
});

test('one paste reaches every slot the company owns', async () => {
  // Anthropic owns two slots: the claude harness and opencode's anthropic target.
  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {});

  assert.equal(result.configured, true);
  assert.deepEqual(
    setCalls.map((call) => `${call.provider}:${call.target ?? '-'}`).sort(),
    ['claude:-', 'opencode:anthropic'],
  );
  assert.ok(setCalls.every((call) => call.apiKey === KEY), 'the same key reaches each slot');
});

test('a subscribed harness is skipped, and its siblings are still written', async () => {
  subscribedProviders = new Set(['claude']);

  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {});

  const claude = result.slots.find((slot) => slot.provider === 'claude');
  assert.equal(claude?.outcome, 'skipped_subscription');
  assert.deepEqual(
    setCalls.map((call) => call.provider),
    ['opencode'],
    'the subscription slot is never handed the key',
  );
  assert.equal(result.configured, true, 'the sibling slot still counts as configured');
});

test('the subscription skip is overridable, but only when asked for', async () => {
  subscribedProviders = new Set(['claude']);

  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {
    includeSubscription: true,
  });

  assert.equal(result.slots.find((slot) => slot.provider === 'claude')?.outcome, 'written');
  assert.ok(setCalls.some((call) => call.provider === 'claude'));
});

test('ADR-152 A1: every slot is the caller\'s own — no role makes a slot `forbidden`', async () => {
  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {});

  assert.equal(result.slots.some((slot) => (slot.outcome as string) === 'forbidden'), false);
  assert.deepEqual(setCalls.map((call) => call.provider).sort(), ['claude', 'opencode']);
});

test('one slot failing does not cancel the others', async () => {
  failingProviders = new Set(['claude']);

  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {});

  const claude = result.slots.find((slot) => slot.provider === 'claude');
  assert.equal(claude?.outcome, 'failed');
  assert.match(claude?.error ?? '', /refused/);
  assert.deepEqual(setCalls.map((call) => call.provider), ['opencode']);
  assert.equal(result.configured, true);
});

test('the failure report never carries the key value', async () => {
  failingProviders = new Set(['claude']);

  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {});

  assert.ok(!JSON.stringify(result).includes(KEY), 'no slot result echoes the secret');
});

test('an empty key is a 400 before any slot is touched', async () => {
  await assert.rejects(
    () => companyCredentialsService.setKey(1, 'anthropic', '   ', {}),
    (error: { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(setCalls, []);
});

test('an unknown company is a 404, not an empty success', async () => {
  await assert.rejects(
    () => companyCredentialsService.setKey(1, 'nope', KEY, {}),
    (error: { statusCode?: number }) => error.statusCode === 404,
  );
});

test('Z.AI — the pure duplicate — fans out to both of its slots', async () => {
  // The case that made this feature worth building: two api_key slots of the
  // same company, holding the very same key, pasted twice by hand until now.
  const result = await companyCredentialsService.setKey(1, 'zai', KEY, {});

  assert.deepEqual(
    setCalls.map((call) => `${call.provider}:${call.target ?? '-'}`).sort(),
    ['glm:-', 'opencode:glm'],
  );
  assert.equal(result.slots.length, 2);
});

// ----------------------- T-1201: the ticked slots only -----------------------

test('a selection writes ONLY the ticked slot and leaves its sibling untouched', async () => {
  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {
    vendorIds: ['anthropic-opencode'],
  });

  assert.deepEqual(
    setCalls.map((call) => `${call.provider}:${call.target ?? '-'}`),
    ['opencode:anthropic'],
    'the unticked slot must not be written at all',
  );
  assert.deepEqual(result.slots.map((slot) => slot.vendorId), ['anthropic-opencode']);
});

test('omitting the selection keeps the old meaning — every slot', async () => {
  // The pre-checkbox client, and the client whose server answered no slot list.
  await companyCredentialsService.setKey(1, 'anthropic', KEY, {});

  assert.equal(setCalls.length, 2, 'an absent selection is not an empty selection');
});

test('a slot id from ANOTHER company cannot be written through this company', async () => {
  // The scope-widening shape: the path says Moonshot, the body names Anthropic's
  // opencode slot. The candidate set comes from the PATH, so the id matches
  // nothing and the call is refused rather than silently redirected.
  await assert.rejects(
    () => companyCredentialsService.setKey(1, 'moonshot', KEY, {
      vendorIds: ['anthropic-opencode'],
    }),
    (error: { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(setCalls, [], 'no slot of any company was touched');
});

test('a selection narrows the write to the ticked slot, in the caller\'s own tree', async () => {
  const result = await companyCredentialsService.setKey(1, 'anthropic', KEY, {
    vendorIds: ['anthropic-opencode'],
  });

  assert.equal(result.slots[0]?.outcome, 'written');
  assert.deepEqual(setCalls.map((call) => call.provider), ['opencode']);
});

test('ticking a subscribed slot still needs the explicit override', async () => {
  subscribedProviders = new Set(['claude']);

  const skipped = await companyCredentialsService.setKey(1, 'anthropic', KEY, {
    vendorIds: ['anthropic'],
  });
  assert.equal(skipped.slots[0]?.outcome, 'skipped_subscription');
  assert.deepEqual(setCalls, [], 'a Max plan is not downgraded by a checkbox alone');

  const overridden = await companyCredentialsService.setKey(1, 'anthropic', KEY, {
    vendorIds: ['anthropic'],
    includeSubscription: true,
  });
  assert.equal(overridden.slots[0]?.outcome, 'written');
  assert.deepEqual(setCalls.map((call) => call.provider), ['claude']);
});

test('an empty selection is a 400, not a silent no-op success', async () => {
  await assert.rejects(
    () => companyCredentialsService.setKey(1, 'anthropic', KEY, {
      vendorIds: [],
    }),
    (error: { statusCode?: number }) => error.statusCode === 400,
  );
  assert.deepEqual(setCalls, []);
});

test('removal is per slot too — one place, not the whole company', async () => {
  const result = await companyCredentialsService.deleteKey(1, 'zai', {
    vendorIds: ['zai-opencode'],
  });

  assert.deepEqual(result.slots.map((slot) => slot.vendorId), ['zai-opencode']);
});

test('ADR-200 S7: alibaba-cloud saves a Token Plan key with no consent and no sk-sp- prefix', async () => {
  const result = await companyCredentialsService.setKey(1, 'alibaba-cloud', 'tp-0123456789abcdef', { auditContext: { ipAddress: '127.0.0.1' },
  });
  assert.equal(result.configured, true);
  assert.equal(setCalls.length, 1);
  assert.equal(setCalls[0].provider, 'qwen');
  assert.equal(setCalls[0].apiKey, 'tp-0123456789abcdef');
  assert.deepEqual(setCalls[0].auditContext, { ipAddress: '127.0.0.1' });
});

test('ADR-200 S7: no company carries a consent requirement any more', async () => {
  for (const companyId of ['alibaba-cloud', 'anthropic']) {
    setCalls = [];
    const result = await companyCredentialsService.setKey(1, companyId, KEY, {});
    assert.equal(result.configured, true, companyId);
    assert.ok(setCalls.every((call) => call.auditContext?.consentVersion === undefined));
  }
});
