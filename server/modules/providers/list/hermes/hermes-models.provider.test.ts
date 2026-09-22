import assert from 'node:assert/strict';
import test, { before, mock } from 'node:test';

// B-1283: proves buildHermesModelCatalog flags a FALLBACK catalog `degraded: true`
// while a genuinely live catalog stays unflagged. Two fallback triggers exist and
// are separated here:
//   * hermes' own files are unreadable (readHermesRuntimeConfig catch ⇒ provider
//     null ⇒ no cached models ⇒ no ids) ⇒ the empty catalog is degraded;
//   * the config default is live but the model CACHE read genuinely FAILED
//     (missing/unreadable/corrupt file) ⇒ the [default] catalog is degraded too,
//     because hermes' own model list never reached it (gap 2).
// A default alone over a LEGITIMATE empty cache (valid file that simply does not
// list this provider yet) is a real result and stays unflagged. The shared
// HERMES_EMPTY_MODELS constant is never mutated on any path.
//
// The on-disk readers are mocked (their own file-read failure paths are covered by
// hermes-runtime.test.ts); this file exercises the catalog-shaping layer.

type RuntimeConfig = { provider: string | null; defaultModel: string | null };
type CachedModels = { models: string[]; failed: boolean };

let runtimeConfig: RuntimeConfig = { provider: null, defaultModel: null };
let cachedModels: CachedModels = { models: [], failed: false };

let buildHermesModelCatalog: typeof import('./hermes.provider.js').buildHermesModelCatalog;
let HERMES_EMPTY_MODELS: typeof import('./hermes.provider.js').HERMES_EMPTY_MODELS;

before(async () => {
  const realRuntime = await import('./hermes-runtime.js');
  mock.module('./hermes-runtime.js', {
    namedExports: {
      ...realRuntime,
      readHermesRuntimeConfig: async () => runtimeConfig,
      readHermesCachedModels: async () => cachedModels,
    },
  });

  ({ buildHermesModelCatalog, HERMES_EMPTY_MODELS } = await import('./hermes.provider.js'));
});

test('unreadable hermes files yield the empty catalog flagged degraded', async () => {
  runtimeConfig = { provider: null, defaultModel: null };
  cachedModels = { models: [], failed: true };

  const result = await buildHermesModelCatalog();

  assert.deepEqual(result, { OPTIONS: [], DEFAULT: '', degraded: true });
  assert.equal(result.degraded, true);
});

test('a live config default and cached models yield a catalog NOT flagged degraded', async () => {
  runtimeConfig = { provider: 'copilot', defaultModel: 'gpt-4o' };
  cachedModels = { models: ['gpt-4o', 'gpt-5.5'], failed: false };

  const result = await buildHermesModelCatalog();

  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['gpt-4o', 'gpt-5.5']);
  assert.equal(result.DEFAULT, 'gpt-4o');
  assert.notEqual(result.degraded, true);
});

test('a live config default over a LEGITIMATE empty cache stays a live, non-degraded catalog', async () => {
  // Valid cache file that simply does not list this provider yet.
  runtimeConfig = { provider: 'copilot', defaultModel: 'gpt-4o' };
  cachedModels = { models: [], failed: false };

  const result = await buildHermesModelCatalog();

  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['gpt-4o']);
  assert.equal(result.DEFAULT, 'gpt-4o');
  assert.notEqual(result.degraded, true);
});

test('a live config default with a FAILED cache read yields a [default] catalog flagged degraded', async () => {
  // The cache file is missing/unreadable — the [default] catalog is incomplete.
  runtimeConfig = { provider: 'copilot', defaultModel: 'gpt-4o' };
  cachedModels = { models: [], failed: true };

  const result = await buildHermesModelCatalog();

  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['gpt-4o']);
  assert.equal(result.DEFAULT, 'gpt-4o');
  assert.equal(result.degraded, true);
});

test('a live config default with a CORRUPT cache (read failure) is degraded', async () => {
  // Corrupt JSON surfaces as failed:true from readHermesCachedModels; the catalog
  // built from the config default alone is therefore incomplete → degraded.
  runtimeConfig = { provider: 'nous', defaultModel: 'hermes-4' };
  cachedModels = { models: [], failed: true };

  const result = await buildHermesModelCatalog();

  assert.deepEqual(result.OPTIONS.map((o) => o.value), ['hermes-4']);
  assert.equal(result.DEFAULT, 'hermes-4');
  assert.equal(result.degraded, true);
});

test('the shared HERMES_EMPTY_MODELS constant is never mutated', async () => {
  runtimeConfig = { provider: null, defaultModel: null };
  cachedModels = { models: [], failed: true };

  const result = await buildHermesModelCatalog();

  assert.notEqual(result, HERMES_EMPTY_MODELS);
  assert.notEqual(HERMES_EMPTY_MODELS.degraded, true);
  assert.deepEqual(HERMES_EMPTY_MODELS, { OPTIONS: [], DEFAULT: '' });
});
