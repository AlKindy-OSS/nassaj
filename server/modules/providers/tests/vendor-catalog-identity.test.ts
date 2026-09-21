/**
 * vendor-catalog-identity.test.ts — B-342: the catalog belongs to whoever asked.
 *
 * The outage this pins: `<vendor>-catalog.client.ts` read its API key with a
 * hardcoded system scope, written when nassaj was single-user. After per-user
 * key storage landed, the lookup pointed at a directory that does not exist, so
 * `fetchLive` returned null on every call for every user, the client served its
 * frozen fallback flagged `degraded`, and the operator's own models (a live
 * `kimi-k3` among them) were simply missing from the picker — with no error
 * anywhere, because "no key" and "degraded" are indistinguishable by design.
 *
 * Three properties are asserted, in the order the repair depends on them:
 *   1. the identity survives the whole chain, service → facet → client → key;
 *   2. two identities fetching AT THE SAME TIME get their own catalogs (the
 *      single-flight promise used to be one field, so the second caller was
 *      handed the first caller's result — and it was cached for three days);
 *   3. one identity's circuit breaker does not silence another's live fetch.
 *
 * Fixtures are the real shapes: the model ids are the ones `api.moonshot.ai/v1/
 * models` returned on this machine on 2026-07-31, not invented strings.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  ANONYMOUS_CATALOG_IDENTITY,
  VendorCatalogClient,
  type CatalogIdentity,
} from '@/modules/providers/shared/vendor/vendor-catalog.client.js';
import { VendorModelsProvider } from '@/modules/providers/shared/vendor/vendor-models.provider.js';
import { VENDOR_RUNTIME } from '@/modules/providers/shared/vendor/vendor-config.js';
import {
  _resetProviderSecretsServerKeyCache,
  getProviderKey,
  setProviderKey,
} from '@/services/isolation/provider-secrets-store.js';

/** Live ids measured from api.moonshot.ai/v1/models (2026-07-31). */
const MOONSHOT_LIVE_IDS = ['kimi-k2.7-code', 'kimi-k2.7-code-highspeed', 'kimi-k3', 'kimi-k2.6'];

const stubFetch = (impl: typeof fetch): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
};

/** Throwaway home + deterministic server key so per-user secrets are writable. */
function withSandbox(): { restore: () => void } {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-catalog-identity-'));
  const originalHomedir = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => homeDir;

  const originalKey = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
  _resetProviderSecretsServerKeyCache();

  return {
    restore: () => {
      (os as unknown as { homedir: () => string }).homedir = originalHomedir;
      if (originalKey === undefined) {
        delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
      } else {
        process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalKey;
      }
      _resetProviderSecretsServerKeyCache();
      fs.rmSync(homeDir, { recursive: true, force: true });
    },
  };
}

/** A client whose key comes from the per-user store, like the real ones. */
const buildKimiClient = (): VendorCatalogClient => new VendorCatalogClient({
  provider: 'kimi',
  modelsUrl: VENDOR_RUNTIME.kimi.modelsUrl,
  getApiKey: (identity: CatalogIdentity) => getProviderKey(identity, 'kimi'),
  fallback: VENDOR_RUNTIME.kimi.fallbackModels,
});

/** Answers with a catalog derived from the bearer token, so results are traceable. */
const fetchKeyedByBearer = (byKey: Record<string, string[]>): typeof fetch =>
  (async (_url: unknown, init?: RequestInit) => {
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
    const key = auth.replace(/^Bearer /, '');
    const ids = byKey[key];
    if (!ids) {
      return new Response('unauthorized', { status: 401 });
    }
    return new Response(JSON.stringify({ data: ids.map((id) => ({ id })) }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  }) as unknown as typeof fetch;

test('B-342: the asking user\'s id reaches getApiKey through the models facet', async () => {
  const sandbox = withSandbox();
  const seen: CatalogIdentity[] = [];
  const client = new VendorCatalogClient({
    provider: 'kimi',
    modelsUrl: VENDOR_RUNTIME.kimi.modelsUrl,
    getApiKey: (identity) => {
      seen.push(identity);
      return null;
    },
    fallback: VENDOR_RUNTIME.kimi.fallbackModels,
  });
  const models = new VendorModelsProvider({
    provider: 'kimi',
    fallback: VENDOR_RUNTIME.kimi.fallbackModels,
    catalog: client,
  });

  try {
    // The facet used to declare `getSupportedModels()` with no parameter at all,
    // so this id was accepted by the interface and silently discarded here.
    await models.getSupportedModels(7);
    assert.deepEqual(seen, [7], 'the identity must arrive at the key lookup unchanged');

    // No identity is still allowed, but it must be an explicit sentinel — never
    // an implicit null that the secrets store would have to guess about. T-1260
    // renamed that sentinel from the store's system scope to a catalog-local
    // bucket: "nobody asked" and "spend the operator's key" were the same token,
    // so a cache bucket doubled as a spending decision.
    await models.getSupportedModels(null);
    assert.equal(seen.length, 2);
    assert.equal(seen[1], ANONYMOUS_CATALOG_IDENTITY);
  } finally {
    sandbox.restore();
  }
});

test('B-342: concurrent lookups by two users never share one catalog', async () => {
  const sandbox = withSandbox();
  setProviderKey('1', 'kimi', 'sk-user-one');
  setProviderKey('2', 'kimi', 'sk-user-two');

  const client = buildKimiClient();
  const restore = stubFetch(fetchKeyedByBearer({
    'sk-user-one': MOONSHOT_LIVE_IDS,
    'sk-user-two': ['kimi-k2.6'],
  }));

  try {
    // Deliberately NOT awaited in sequence: the shared single-flight field only
    // leaks when the second call arrives while the first is still in flight.
    const [one, two] = await Promise.all([
      client.getCatalog('1'),
      client.getCatalog('2'),
    ]);

    assert.ok(one.OPTIONS.some((option) => option.value === 'kimi-k3'), 'user 1 sees their own list');
    assert.deepEqual(
      two.OPTIONS.map((option) => option.value),
      ['kimi-k2.6'],
      'user 2 must not receive the catalog built from user 1\'s key',
    );
  } finally {
    restore();
    sandbox.restore();
  }
});

test('B-342: one user\'s open circuit does not block another user\'s live fetch', async () => {
  const sandbox = withSandbox();
  setProviderKey('2', 'kimi', 'sk-user-two');

  const client = buildKimiClient();
  let calls = 0;
  const restore = stubFetch((async (_url: unknown, init?: RequestInit) => {
    calls += 1;
    const auth = String((init?.headers as Record<string, string> | undefined)?.Authorization ?? '');
    if (auth === 'Bearer sk-user-two') {
      return new Response(JSON.stringify({ data: [{ id: 'kimi-k3' }] }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('boom', { status: 500 });
  }) as unknown as typeof fetch);

  try {
    // User 9 has no key at all: three failures is exactly the breaker threshold.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const degraded = await client.getCatalog('9');
      assert.equal(degraded.degraded, true);
    }

    const callsBefore = calls;
    const live = await client.getCatalog('2');
    assert.notEqual(live.degraded, true, 'user 2 must still get a live catalog');
    assert.ok(calls > callsBefore, 'the network must actually be reached for user 2');
    assert.ok(live.OPTIONS.some((option) => option.value === 'kimi-k3'));
  } finally {
    restore();
    sandbox.restore();
  }
});
