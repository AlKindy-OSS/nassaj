import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  __resetAntigravityCatalogCircuit,
  getAntigravityModelCatalog,
  parseCatalog,
} from '@/modules/providers/list/antigravity/antigravity-catalog.client.js';
import { ANTIGRAVITY_FALLBACK_MODELS } from '@/modules/providers/list/antigravity/antigravity-models.provider.js';

const patchHomeDir = (nextHomeDir: string): (() => void) => {
  const original = os.homedir;
  (os as unknown as { homedir: () => string }).homedir = () => nextHomeDir;
  return () => {
    (os as unknown as { homedir: () => string }).homedir = original;
  };
};

const writeTokenFile = async (homeDir: string, accessToken: string | null): Promise<void> => {
  const dir = path.join(homeDir, '.gemini', 'antigravity-cli');
  await fs.mkdir(dir, { recursive: true });
  const payload =
    accessToken === null
      ? { token: {}, auth_method: 'oauth' }
      : { token: { access_token: accessToken }, auth_method: 'oauth' };
  await fs.writeFile(path.join(dir, 'antigravity-oauth-token'), JSON.stringify(payload), 'utf8');
};

const stubFetch = (impl: typeof fetch): (() => void) => {
  const original = globalThis.fetch;
  globalThis.fetch = impl;
  return () => {
    globalThis.fetch = original;
  };
};

// ---------------- parseCatalog (pure) ----------------

test('parseCatalog: maps modelId/displayName entries and prepends "auto"', () => {
  const result = parseCatalog({
    models: [
      { modelId: 'gemini-3-pro', displayName: 'Gemini 3 Pro' },
      { modelId: 'gemini-3-flash', displayName: 'Gemini 3 Flash' },
    ],
  });

  assert.ok(result);
  assert.equal(result.OPTIONS[0].value, 'auto');
  assert.ok(result.OPTIONS.some((o) => o.value === 'gemini-3-pro' && o.label === 'Gemini 3 Pro'));
  assert.equal(result.DEFAULT, ANTIGRAVITY_FALLBACK_MODELS.DEFAULT);
});

test('parseCatalog: accepts alias fields (model/name + label) and de-dupes', () => {
  const result = parseCatalog({
    availableModels: [
      { model: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
      { name: 'gemini-2.5-pro' }, // duplicate value -> dropped
      { id: 'gemini-2.5-flash' }, // label falls back to value
    ],
  });

  assert.ok(result);
  const values = result.OPTIONS.map((o) => o.value);
  assert.equal(values.filter((v) => v === 'gemini-2.5-pro').length, 1);
  const flash = result.OPTIONS.find((o) => o.value === 'gemini-2.5-flash');
  assert.equal(flash?.label, 'gemini-2.5-flash');
});

test('parseCatalog: returns null for unusable bodies', () => {
  assert.equal(parseCatalog(null), null);
  assert.equal(parseCatalog({}), null);
  assert.equal(parseCatalog({ models: [] }), null);
  assert.equal(parseCatalog({ models: [{ junk: true }] }), null);
});

// ---------------- getAntigravityModelCatalog (integration) ----------------

test('getAntigravityModelCatalog: falls back when no token file exists', async () => {
  __resetAntigravityCatalogCircuit();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-catalog-notoken-'));
  const restoreHome = patchHomeDir(tempRoot);
  const restoreFetch = stubFetch(async () => {
    throw new Error('fetch must not be called without a token');
  });
  try {
    const result = await getAntigravityModelCatalog();
    assert.deepEqual(result, { ...ANTIGRAVITY_FALLBACK_MODELS, degraded: true });
  } finally {
    restoreFetch();
    restoreHome();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('getAntigravityModelCatalog: returns live catalog on a successful fetch', async () => {
  __resetAntigravityCatalogCircuit();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-catalog-live-'));
  const restoreHome = patchHomeDir(tempRoot);
  await writeTokenFile(tempRoot, 'test-token');
  const restoreFetch = stubFetch(async () =>
    new Response(JSON.stringify({ models: [{ modelId: 'gemini-9-pro', displayName: 'Gemini 9 Pro' }] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  try {
    const result = await getAntigravityModelCatalog();
    assert.ok(result.OPTIONS.some((o) => o.value === 'gemini-9-pro'));
    // A live fetch is authoritative — it must NOT be flagged degraded, so the
    // provider-models cache keeps it under the normal long TTL.
    assert.notEqual(result.degraded, true);
  } finally {
    restoreFetch();
    restoreHome();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});

test('getAntigravityModelCatalog: falls back on HTTP error and opens the breaker', async () => {
  __resetAntigravityCatalogCircuit();
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'agy-catalog-401-'));
  const restoreHome = patchHomeDir(tempRoot);
  await writeTokenFile(tempRoot, 'expired-token');
  let calls = 0;
  const restoreFetch = stubFetch(async () => {
    calls += 1;
    return new Response('unauthorized', { status: 401 });
  });
  try {
    // Threshold is 3 consecutive failures; the 4th call must be short-circuited
    // by the open breaker and not hit fetch again.
    for (let i = 0; i < 3; i += 1) {
      const result = await getAntigravityModelCatalog();
      assert.deepEqual(result, { ...ANTIGRAVITY_FALLBACK_MODELS, degraded: true });
    }
    assert.equal(calls, 3);

    const afterOpen = await getAntigravityModelCatalog();
    assert.deepEqual(afterOpen, { ...ANTIGRAVITY_FALLBACK_MODELS, degraded: true });
    assert.equal(calls, 3, 'breaker must be open: no further fetch calls');
  } finally {
    restoreFetch();
    restoreHome();
    __resetAntigravityCatalogCircuit();
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
});
