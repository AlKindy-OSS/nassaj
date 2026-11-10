/**
 * local-models.context-window.test — B-1755.
 *
 * A local server's catalogue refresh stored only `{ id }`, so the generated
 * opencode.json carried no `limit` and opencode could not know the model's window.
 * The refresh now probes the server for the context window (llama.cpp `/props`,
 * or the OpenAI-compatible `/models` metadata), stores it as `contextWindow`, the
 * generated config carries `limit.context`, and `checkLocalModelContextFit`
 * refuses a launch whose fixed base prompt alone exceeds the window.
 *
 * No real server is contacted: the transport is a fake keyed by URL path.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-local-ctx-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
process.env.HOME = path.join(sandbox, 'home');
fs.mkdirSync(process.env.HOME, { recursive: true });
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

const db = await import('@/modules/database/index.js');
const { _resetProviderSecretsServerKeyCache } = await import('@/services/isolation/provider-secrets-store.js');
const {
  checkLocalModelContextFit,
  LOCAL_OUTPUT_RESERVE_TOKENS,
  localModelOutputReserve,
  estimatePromptTokens,
  localModelContextWindow,
  localModelProviderBlocks,
  LOCAL_MODEL_CONTEXT_EXCEEDED,
} = await import('@/services/isolation/local-model-config.js');
const { createLocalModelsService, localProviderId } = await import('./services/local-models.service.js');

await db.initializeDatabase();
_resetProviderSecretsServerKeyCache();
db.appConfigDb.set('local_models.enabled', 'true');
db.appConfigDb.set('local_models.consent_version', '1');

const owner = db.userDb.createUser('ctx-owner', 'hash', 'user');
const SERVER_ID = crypto.randomUUID();
const PROVIDER_ID = localProviderId(SERVER_ID);

after(() => {
  db.closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

type FakeRoutes = Record<string, Record<string, unknown> | Error>;
const requested: string[] = [];

/** Real repository/config/audit, fake transport, no API key. */
const serviceWith = (routes: FakeRoutes) => createLocalModelsService({
  repository: db.localModelServersDb, config: db.appConfigDb, audit: db.auditLogDb,
  transaction: <T>(work: () => T): T => db.getConnection().transaction(work)(),
  fetchJson: async (url: string) => {
    requested.push(url);
    const reply = routes[new URL(url).pathname];
    if (!reply) throw new Error('not found');
    if (reply instanceof Error) throw reply;
    return reply;
  },
  probeAuth: async () => ({ status: 400 }),
  secrets: { get: () => null, set: () => {}, remove: () => {}, has: () => false },
} as never);

const saveServer = (models: Array<Record<string, unknown>>, runtime = 'llamacpp') => db.localModelServersDb.save({
  id: SERVER_ID, ownerId: owner.id, providerId: PROVIDER_ID, name: 'qwen box',
  baseUrl: 'http://127.0.0.1:8080/v1', runtime: runtime as never, models: models as never,
});
const storedModels = () => db.localModelServersDb.get(SERVER_ID, owner.id)!.models;

beforeEach(() => { requested.length = 0; });

describe('B-1755 acceptance: probe → store → config → guard', () => {
  it('n_ctx 16384 is stored, written as limit.context, and a 22k base prompt is refused', async () => {
    saveServer([{ id: 'qwen3.6-35b' }]);
    const service = serviceWith({
      '/v1/models': { data: [{ id: 'qwen3.6-35b' }] },
      '/props': { default_generation_settings: { n_ctx: 16384 } },
    });

    const result = await service.catalog(owner.id, SERVER_ID, true);
    assert.equal(result.models[0].contextWindow, 16384);
    assert.equal(storedModels()[0].contextWindow, 16384);
    assert.ok(requested.includes('http://127.0.0.1:8080/props'), 'probes the server root, not /v1/props');

    const block = localModelProviderBlocks(owner.id)[PROVIDER_ID];
    assert.equal(block.models['qwen3.6-35b'].limit.context, 16384);
    const output = block.models['qwen3.6-35b'].limit.output;
    assert.ok(output > 0 && output <= 16384 / 4, `output ${output} leaves room for the prompt`);

    const model = `${PROVIDER_ID}/qwen3.6-35b`;
    assert.equal(localModelContextWindow(owner.id, model), 16384);
    const refusal = checkLocalModelContextFit({ contextWindow: 16384, basePromptTokens: 22000 });
    assert.equal(refusal?.code, LOCAL_MODEL_CONTEXT_EXCEEDED);
    assert.equal(refusal?.reason, 'base');
    assert.equal(refusal?.contextWindow, 16384);
    assert.equal(refusal?.basePromptTokens, 22000);
    assert.equal(LOCAL_MODEL_CONTEXT_EXCEEDED, 'LOCAL_MODEL_CONTEXT_EXCEEDED');
  });
});

describe('B-1755 probe sources and fallbacks', () => {
  it('reads OpenAI-compatible /models metadata when /props is absent (vLLM max_model_len)', async () => {
    saveServer([{ id: 'a' }, { id: 'b' }], 'vllm');
    const service = serviceWith({ '/v1/models': { data: [{ id: 'a', max_model_len: 32768 }, { id: 'b', meta: { n_ctx_train: 8192 } }] } });
    const { models } = await service.catalog(owner.id, SERVER_ID, false);
    assert.deepEqual(models.map(m => m.contextWindow), [32768, 8192]);
  });

  it('keeps a manually entered window when the server reports none', async () => {
    saveServer([{ id: 'qwen3.6-35b', contextWindow: 12000, maxOutput: 2000 }], 'ollama');
    const service = serviceWith({ '/v1/models': { data: [{ id: 'qwen3.6-35b' }] }, '/props': new Error('404') });
    const { models } = await service.catalog(owner.id, SERVER_ID, false);
    assert.deepEqual(models, [{ id: 'qwen3.6-35b', contextWindow: 12000, maxOutput: 2000 }]);
  });

  it('a training-size hint (n_ctx_train) never overrides a manual window', async () => {
    saveServer([{ id: 'a', contextWindow: 12000 }, { id: 'b' }]);
    const service = serviceWith({ '/v1/models': { data: [{ id: 'a', meta: { n_ctx_train: 262144 } }, { id: 'b' }] } });
    const { models } = await service.catalog(owner.id, SERVER_ID, false);
    assert.deepEqual(models, [{ id: 'a', contextWindow: 12000 }, { id: 'b' }]);
  });

  it('a probed window replaces a stale one and drops a maxOutput that no longer fits', async () => {
    saveServer([{ id: 'm', contextWindow: 65536, maxOutput: 16384 }]);
    const service = serviceWith({ '/v1/models': { data: [{ id: 'm' }] }, '/props': { n_ctx: 8192 } });
    const { models } = await service.catalog(owner.id, SERVER_ID, false);
    assert.deepEqual(models, [{ id: 'm', contextWindow: 8192 }]);
  });

  it('ignores /props for a multi-model catalogue and nonsense sizes', async () => {
    saveServer([]);
    const service = serviceWith({
      '/v1/models': { data: [{ id: 'x', context_length: -5 }, { id: 'y', context_length: '4096' }] },
      '/props': { n_ctx: 16384 },
    });
    const { models } = await service.catalog(owner.id, SERVER_ID, false);
    assert.deepEqual(models, [{ id: 'x' }, { id: 'y' }]);
  });

  it('a failing /props probe never fails the catalogue', async () => {
    saveServer([]);
    const service = serviceWith({ '/v1/models': { data: [{ id: 'z' }] }, '/props': new Error('boom') });
    const { connected, models } = await service.catalog(owner.id, SERVER_ID, false);
    assert.equal(connected, true);
    assert.deepEqual(models, [{ id: 'z' }]);
  });
});

describe('B-1755 checkLocalModelContextFit', () => {
  it('unknown window passes (ADR-223 behaviour)', () => {
    assert.equal(checkLocalModelContextFit({ contextWindow: undefined, basePromptTokens: 999999 }), null);
    assert.equal(checkLocalModelContextFit({ contextWindow: null, basePromptTokens: 999999 }), null);
  });

  it('a base prompt inside the window passes; at or over the window refuses', () => {
    assert.equal(checkLocalModelContextFit({ contextWindow: 16384, basePromptTokens: 12000 }), null);
    assert.equal(checkLocalModelContextFit({ contextWindow: 16384, basePromptTokens: 16384 })?.code, LOCAL_MODEL_CONTEXT_EXCEEDED);
  });

  it('I8: the reply reserve and working margin count against the window', () => {
    const fit = { contextWindow: 16384, basePromptTokens: 14000 };
    assert.equal(checkLocalModelContextFit(fit), null, 'base alone fits');
    const refused = checkLocalModelContextFit({ ...fit, outputReserveTokens: 4096, marginTokens: 4096 });
    assert.equal(refused?.reason, 'base');
    assert.equal(checkLocalModelContextFit({ contextWindow: 32768, basePromptTokens: 14000, outputReserveTokens: 8192, marginTokens: 4096 }), null);
  });

  it('I8: a resumed session whose stored fill leaves no reply room refuses as history', () => {
    const base = { contextWindow: 32768, basePromptTokens: 14000, outputReserveTokens: 4096, marginTokens: 4096 };
    assert.equal(checkLocalModelContextFit({ ...base, storedFillTokens: 30000 })?.reason, 'history');
    assert.equal(checkLocalModelContextFit({ ...base, storedFillTokens: 20000 }), null);
    assert.equal(checkLocalModelContextFit({ ...base, storedFillTokens: null }), null);
  });

  it('I8: the output reserve is the generated limit, never below 4096', () => {
    assert.equal(localModelOutputReserve(owner.id, 'anthropic/claude'), LOCAL_OUTPUT_RESERVE_TOKENS);
    assert.equal(localModelOutputReserve(owner.id, `${PROVIDER_ID}/nope`), LOCAL_OUTPUT_RESERVE_TOKENS);
    assert.ok(LOCAL_OUTPUT_RESERVE_TOKENS === 4096);
  });

  it('localModelContextWindow is null for non-local, unknown or unowned models', () => {
    assert.equal(localModelContextWindow(owner.id, 'anthropic/claude'), null);
    assert.equal(localModelContextWindow(owner.id, `${PROVIDER_ID}/nope`), null);
    assert.equal(localModelContextWindow(owner.id + 999, `${PROVIDER_ID}/m`), null);
  });

  it('estimatePromptTokens rounds characters up to tokens', () => {
    assert.equal(estimatePromptTokens(''), 0);
    assert.equal(estimatePromptTokens('abcd'), 1);
    assert.equal(estimatePromptTokens('a'.repeat(88000)), 22000);
  });
});
