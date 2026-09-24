/**
 * local-models.catalog-auth.test — B-1298(a) authenticated catalogue probe.
 *
 * `/models` is served UNAUTHENTICATED by llama.cpp, so a wrong API key would pass the
 * old catalogue check silently. `catalog` now runs an authenticated probe first and maps
 * a 401/403 to a distinct `LOCAL_MODELS_AUTH_FAILED` code, while a valid key (which the
 * probe endpoint answers with a 4xx validation error) proceeds to list models.
 *
 * Pure unit test: repository / config / secrets / transport are all injected stubs.
 */

import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createLocalModelsService,
  LOCAL_MODELS_AUTH_FAILED_STATUS,
  LOCAL_MODELS_CONSENT_VERSION,
} from './local-models.service.js';

const SERVER = {
  id: 'srv-1', ownerId: 7, name: 'local', baseUrl: 'http://127.0.0.1:8080/v1',
  runtime: 'llamacpp' as const, models: [{ id: 'llama-3' }], providerId: 'nassaj_local_srv1',
};

const buildDeps = (over: {
  apiKey?: string | null;
  probeAuth?: (url: string, key?: string | null) => Promise<{ status: number }>;
  fetchJson?: (url: string, key?: string | null) => Promise<Record<string, unknown>>;
  probeCalls?: string[];
}) => ({
  repository: {
    get: () => SERVER,
    updateModels: () => true,
    list: () => [], count: () => 0, save: () => {}, remove: () => {},
  },
  config: {
    get: (key: string) => key === 'local_models.enabled' ? 'true'
      : key === 'local_models.consent_version' ? LOCAL_MODELS_CONSENT_VERSION : undefined,
    set: () => {},
  },
  audit: { recordStrict: () => {} },
  fetchJson: over.fetchJson ?? (async () => ({ data: [{ id: 'llama-3' }] })),
  probeAuth: over.probeAuth ?? (async () => ({ status: 400 })),
  transaction: <T>(work: () => T): T => work(),
  secrets: {
    get: () => (over.apiKey === undefined ? 'configured-key' : over.apiKey),
    set: () => {}, remove: () => {}, has: () => true,
  },
}) as never;

describe('LocalModelsService.catalog — B-1298(a) auth probe', () => {
  it('maps a probe 401 to LOCAL_MODELS_AUTH_FAILED', async () => {
    const service = createLocalModelsService(buildDeps({ probeAuth: async () => ({ status: 401 }) }));
    await assert.rejects(service.catalog(7, 'srv-1', false), (error: unknown) => {
      const err = error as { code?: string; statusCode?: number };
      assert.equal(err.code, 'LOCAL_MODELS_AUTH_FAILED');
      assert.equal(err.statusCode, LOCAL_MODELS_AUTH_FAILED_STATUS);
      return true;
    });
  });

  it('never answers a rejected key with 401 (that would log the user out)', () => {
    // The client's isSessionRejection reads body.code only, so any 401 from this API
    // is taken for a Nassaj session rejection and ends in auth:unauthorized.
    assert.notEqual(LOCAL_MODELS_AUTH_FAILED_STATUS, 401);
  });

  it('does NOT treat a probe 403 as an auth failure (proxy/WAF, key may be valid)', async () => {
    const service = createLocalModelsService(buildDeps({ probeAuth: async () => ({ status: 403 }) }));
    const result = await service.catalog(7, 'srv-1', false);
    assert.equal(result.connected, true);
  });

  it('lists models when the probe returns a validation error for a valid key', async () => {
    const service = createLocalModelsService(buildDeps({ probeAuth: async () => ({ status: 400 }) }));
    const result = await service.catalog(7, 'srv-1', false);
    assert.equal(result.connected, true);
    assert.deepEqual(result.models, [{ id: 'llama-3' }]);
  });

  it('skips the probe entirely when no key is configured', async () => {
    const probeCalls: string[] = [];
    const service = createLocalModelsService(buildDeps({
      apiKey: null,
      probeAuth: async (url: string) => { probeCalls.push(url); return { status: 401 }; },
    }));
    const result = await service.catalog(7, 'srv-1', false);
    assert.equal(result.connected, true);
    assert.deepEqual(probeCalls, []);
  });

  it('maps a probe transport failure to LOCAL_MODELS_CONNECTION_FAILED', async () => {
    const service = createLocalModelsService(buildDeps({
      probeAuth: async () => { throw new Error('boom'); },
    }));
    await assert.rejects(service.catalog(7, 'srv-1', false), (error: unknown) => {
      const err = error as { code?: string; statusCode?: number };
      assert.equal(err.code, 'LOCAL_MODELS_CONNECTION_FAILED');
      assert.equal(err.statusCode, 502);
      return true;
    });
  });

  it('probes the /chat/completions path derived from the saved baseUrl', async () => {
    const probeCalls: string[] = [];
    const service = createLocalModelsService(buildDeps({
      probeAuth: async (url: string) => { probeCalls.push(url); return { status: 400 }; },
    }));
    await service.catalog(7, 'srv-1', false);
    assert.deepEqual(probeCalls, ['http://127.0.0.1:8080/v1/chat/completions']);
  });

  it('does not double the slash for a baseUrl stored with a trailing slash', async () => {
    const urls: string[] = [];
    const deps = buildDeps({
      probeAuth: async (url: string) => { urls.push(url); return { status: 400 }; },
      fetchJson: async (url: string) => { urls.push(url); return { data: [{ id: 'llama-3' }] }; },
    }) as { repository: { get: () => unknown } };
    deps.repository.get = () => ({ ...SERVER, baseUrl: 'http://127.0.0.1:8080/v1/' });
    await createLocalModelsService(deps as never).catalog(7, 'srv-1', false);
    assert.deepEqual(urls, [
      'http://127.0.0.1:8080/v1/chat/completions',
      'http://127.0.0.1:8080/v1/models',
    ]);
  });
});
