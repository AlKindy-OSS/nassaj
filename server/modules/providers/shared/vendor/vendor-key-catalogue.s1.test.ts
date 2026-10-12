/**
 * vendor-key-catalogue.s1.test.ts — ADR-200 S1 acceptance, server side.
 *
 *   1. Reverse drift: every server-side key reader has a catalogue row, and
 *      every catalogue cell with a measured writer names a real reader.
 *   2. The canonical `vendor:*` records are unreadable by `resolveProviderEnv`,
 *      by `resolveSlotKey` and by `delegate_to_vendor`.
 *   3. The canonical store is in-flag (no write while the flag is off), refuses
 *      a Claude subscription token, and is reachable through no other door.
 *
 * Hermetic: sandboxed $HOME and DB, pinned secrets key, stubbed fetch.
 * Runner: node:test + node:assert/strict.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, afterEach, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-vendor-catalogue-s1-'));
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
const ORIGINAL = {
  HOME: process.env.HOME,
  XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  NASSAJ_PROVIDER_SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
  NASSAJ_UNIFIED_VENDOR_KEYS: process.env.NASSAJ_UNIFIED_VENDOR_KEYS,
};
process.env.HOME = sandboxHome;
process.env.XDG_DATA_HOME = path.join(sandbox, 'xdg');
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';

const { VENDOR_KEY_CATALOGUE, CANONICAL_VENDOR_IDS } = await import('../../../../../shared/vendors.js');
const store = await import('@/services/isolation/provider-secrets-store.js');
const { resolveSlotKey } = await import('@/services/isolation/provider-slot-key.js');
const { resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js');
const { ELIGIBLE_ENGINE_PROVIDERS } = await import('@/services/isolation/provider-anthropic-endpoints.js');
const { QWEN_PLAN_KEY_ENV } = await import('@/services/isolation/opencode-qwen-plan.js');
const { KNOWN_PROVIDERS, setProviderSharingConfig, _resetProviderSharingCache } =
  await import('@/services/provider-sharing.js');
const { DELEGATE_PROVIDERS, buildVendorDelegateMcp } =
  await import('./vendor-delegate-mcp.js');
const { OPENCODE_CREDENTIAL_TARGETS } =
  await import('@/modules/providers/list/opencode/opencode-credentials.writer.js');
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');

await initializeDatabase();

const MEMBER = '41';
const SECRET = (vendorId: string) => `sk-canonical-${vendorId}-ZZSECRETZZ`;

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

afterEach(() => {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
});

const consumers = VENDOR_KEY_CATALOGUE.flatMap((row) =>
  row.consumers.map((consumer) => ({ row, consumer })));

/** Stores every canonical key for MEMBER with the flag armed, then disarms it. */
function seedCanonicalKeys(): void {
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
  for (const vendorId of CANONICAL_VENDOR_IDS) {
    store.setCanonicalVendorKey(MEMBER, vendorId, SECRET(vendorId));
  }
  process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
}

describe('reverse drift: server key readers <-> catalogue rows', () => {
  it('the delegate set is exactly the rows with a delegate_tool consumer', () => {
    const rows = consumers.filter(({ consumer }) => consumer.how === 'delegate_tool').map(({ row }) => row.secretId);
    assert.deepEqual(new Set(rows), new Set(DELEGATE_PROVIDERS));
  });

  it('the engine-pin seam set is exactly the rows with an engine_pin consumer', () => {
    const rows = consumers.filter(({ consumer }) => consumer.how === 'engine_pin').map(({ row }) => row.secretId);
    assert.deepEqual(new Set(rows), new Set(ELIGIBLE_ENGINE_PROVIDERS));
  });

  it('every OpenCode auth.json target has exactly one catalogue cell, and no cell invents one', () => {
    const targets = consumers
      .filter(({ consumer }) => consumer.delivery.kind === 'cli_file' && consumer.delivery.provider === 'opencode')
      .map(({ consumer }) => (consumer.delivery as { target?: string }).target);
    assert.equal(new Set(targets).size, targets.length);
    assert.deepEqual(new Set(targets), new Set(OPENCODE_CREDENTIAL_TARGETS));
  });

  it('the legacy vendor slots are exactly the non-canonical canonical records', () => {
    const legacy = VENDOR_KEY_CATALOGUE.map((row) => row.secretId).filter((id) => !id.startsWith('vendor:'));
    assert.deepEqual(new Set(legacy), new Set(store.VENDOR_SECRET_PROVIDERS));
  });

  it('the hosted-run readers are the isolatable vendor slots that inject a key', () => {
    // resolve-provider-env.js VENDOR_KEY_ENV — `qwen` injects nothing there.
    const hosted = consumers.filter(({ consumer }) => consumer.how === 'hosted_run');
    assert.deepEqual(new Set(hosted.map(({ row }) => row.secretId)), new Set(['kimi', 'deepseek', 'glm']));
    for (const { row } of hosted) assert.ok(KNOWN_PROVIDERS.includes(row.secretId));
  });

  it('the Token Plan cell reads the env the qwen-plan path injects', () => {
    const tokenPlan = VENDOR_KEY_CATALOGUE.find((row) => row.secretId === 'qwen');
    assert.deepEqual(tokenPlan?.consumers.map((c) => c.delivery), [{ kind: 'spawn', env: QWEN_PLAN_KEY_ENV }]);
  });
});

describe('canonical records are unreadable by every slot reader', () => {
  it('resolveSlotKey refuses a canonical id in both spellings and both fallback modes', () => {
    for (const vendorId of CANONICAL_VENDOR_IDS) {
      for (const slot of [vendorId, `vendor:${vendorId}`]) {
        for (const sharedFallback of [true, false]) {
          assert.throws(() => resolveSlotKey(MEMBER, slot as never, { sharedFallback }), TypeError);
          assert.throws(() => resolveSlotKey(null, slot as never, { sharedFallback }), TypeError);
        }
      }
    }
  });

  it('resolveProviderEnv never hands a canonical key to any known provider', () => {
    seedCanonicalKeys();
    _resetProviderSharingCache();
    setProviderSharingConfig(Object.fromEntries(KNOWN_PROVIDERS.map((p: string) => [p, 'isolated'])));
    const secrets = CANONICAL_VENDOR_IDS.map(SECRET);
    // Non-vacuous: the isolated branch really ran (not the shared early return).
    assert.ok(resolveProviderEnv(MEMBER, 'claude', {}, 'agent').CLAUDE_CONFIG_DIR);
    for (const provider of KNOWN_PROVIDERS) {
      for (const mode of ['chat', 'agent']) {
        const env = resolveProviderEnv(MEMBER, provider, {}, mode);
        const leaked = Object.values(env).filter((value) => secrets.some((s) => String(value).includes(s)));
        assert.deepEqual(leaked, [], `${provider}/${mode} received a canonical key`);
      }
    }
  });

  it('delegate_to_vendor refuses a canonical vendor and makes no network call', async () => {
    seedCanonicalKeys();
    const original = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => { calls += 1; throw new Error('no network'); }) as typeof fetch;
    try {
      const server = buildVendorDelegateMcp(MEMBER) as unknown as {
        instance: { _registeredTools: Record<string, { handler: (a: unknown) => unknown }> };
      };
      const handler = server.instance._registeredTools.delegate_to_vendor.handler;
      for (const vendorId of CANONICAL_VENDOR_IDS) {
        for (const provider of [vendorId, `vendor:${vendorId}`]) {
          const result = await handler({ provider, prompt: 'hi' }) as { isError?: boolean };
          assert.equal(result.isError, true, `${provider} must be refused`);
        }
      }
      assert.equal(calls, 0);
    } finally {
      globalThis.fetch = original;
    }
  });
});

describe('canonical store: in-flag, member-scoped, its own door', () => {
  it('refuses every write while the flag is off and writes nothing', () => {
    const user = '42';
    assert.equal(store.isUnifiedVendorKeysEnabled(), false);
    assert.throws(() => store.setCanonicalVendorKey(user, 'anthropic', 'sk-ant-api03-x'), /NASSAJ_UNIFIED_VENDOR_KEYS/);
    assert.equal(fs.existsSync(path.join(sandboxHome, '.nassaj-users', user)), false);
  });

  it('round-trips a key with the flag on; delete stays open with the flag off', () => {
    const user = '43';
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = 'true';
    assert.deepEqual(store.setCanonicalVendorKey(user, 'openai', '  sk-proj-abc  '), { vendorId: 'openai', stored: true });
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '0';
    assert.equal(store.getCanonicalVendorKey(user, 'openai'), 'sk-proj-abc');
    const raw = fs.readFileSync(path.join(sandboxHome, '.nassaj-users', user, '.provider-secrets', 'keys.json'), 'utf8');
    assert.deepEqual(Object.keys(JSON.parse(raw)), ['vendor:openai']);
    assert.ok(!raw.includes('sk-proj-abc'), 'encrypted at rest');
    assert.deepEqual(store.deleteCanonicalVendorKey(user, 'openai'), { vendorId: 'openai', removed: true });
    assert.equal(store.getCanonicalVendorKey(user, 'openai'), null);
  });

  it('refuses a Claude subscription token of any generation, for every vendor', () => {
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
    for (const vendorId of CANONICAL_VENDOR_IDS) {
      for (const token of ['sk-ant-oat01-ZZ', 'sk-ant-oat02-ZZ', ' sk-ant-oat17-ZZ ']) {
        assert.throws(() => store.setCanonicalVendorKey('44', vendorId, token), (error: Error) => (
          /subscription token/.test(error.message) && !error.message.includes('ZZ')
        ));
      }
    }
    assert.equal(store.getCanonicalVendorKey('44', 'anthropic'), null);
  });

  it('refuses unknown vendors, legacy slot ids and the operator scope', () => {
    process.env.NASSAJ_UNIFIED_VENDOR_KEYS = '1';
    for (const id of ['kimi', 'google', 'vendor:anthropic']) {
      assert.throws(() => store.setCanonicalVendorKey(MEMBER, id, 'k'), /Unsupported canonical vendor/);
    }
    assert.throws(() => store.setCanonicalVendorKey(store.SYSTEM_SECRET_SCOPE, 'anthropic', 'k'), TypeError);
    assert.throws(() => store.getCanonicalVendorKey(null as never, 'anthropic'), TypeError);
  });

  it('no legacy or namespaced accessor reaches a canonical record', () => {
    seedCanonicalKeys();
    assert.deepEqual(store.listProviderKeys(MEMBER), []);
    for (const vendorId of CANONICAL_VENDOR_IDS) {
      assert.equal(store.getProviderKey(MEMBER, vendorId as never), null);
      assert.throws(() => store.getNamespacedSecret(MEMBER, 'vendor', vendorId), /Unsupported secret provider/);
      assert.equal(store.getCanonicalVendorKey(MEMBER, vendorId), SECRET(vendorId));
    }
  });
});
