/**
 * ADR-227 / T-2098 stage 3a — applyClaudeLocalEngineEnv: the Claude body on a
 * caller-owned local model server. Pure unit test: every dependency is injected.
 */

import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import {
  CLAUDE_LOCAL_BASE_PROMPT_TOKENS,
  CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS,
  CLAUDE_LOCAL_OUTPUT_CAP_TOKENS,
  LOCAL_NO_KEY_PLACEHOLDER,
  applyClaudeLocalEngineEnv,
  applyClaudeLocalEngineEnvOrThrow,
  minimumClaudeLocalContextWindow,
} from './apply-claude-local-engine-env.js';
import { formatLocalEnginePin } from './local-engine-pin.js';

const OWNER = 7;
const SERVER = {
  id: '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11',
  ownerId: OWNER,
  providerId: 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11',
  name: 'Fedora',
  baseUrl: 'http://192.168.8.137:8080/v1',
  verifiedAddresses: ['192.168.8.137'],
  runtime: 'llamacpp',
  models: [
    { id: 'gpt-oss-20b', contextWindow: 32768 },
    { id: 'qwen3.6-35b', contextWindow: 32768, maxOutput: 2048 },
    { id: 'no-window' },
    { id: 'tiny', contextWindow: 16384 },
    { id: 'Claude-sneaky', contextWindow: 32768 },
  ],
};
const MODEL = `${SERVER.providerId}/gpt-oss-20b`;
const ORIGIN = 'http://192.168.8.137:8080';

let state;
const deps = () => ({
  enabled: () => state.enabled,
  runnable: () => state.runnable,
  listServers: (userId) => state.servers.filter((server) => server.ownerId === Number(userId)),
  getSecret: (ownerId, serverId) => (ownerId === OWNER && serverId === SERVER.id ? state.secret : null),
  resolvePrivate: async (url) => {
    state.resolved.push(url);
    if (state.resolveError) throw state.resolveError;
    return { address: '192.168.8.137', family: 4 };
  },
  cliVersionProven: async () => true,
});

beforeEach(() => {
  state = { enabled: true, runnable: true, servers: [SERVER], secret: 'sk-local', resolveError: null, resolved: [] };
});

const apply = (input, env = {}) => applyClaudeLocalEngineEnv(env, { userId: OWNER, ...input }, deps());

describe('applied verdict', () => {
  it('sets the measured working env and authorizes the origin only', async () => {
    const env = { CLAUDE_CODE_USE_BEDROCK: '1', ANTHROPIC_UNIX_SOCKET: '/run/x.sock', HOME: '/home/user' };
    const verdict = await apply({ requestedModel: MODEL }, env);
    assert.equal(verdict.status, 'applied');
    assert.equal(verdict.provider, 'local');
    assert.equal(verdict.hosts.size, 0, 'no host-only authorization for a local engine');
    assert.deepEqual([...verdict.origins], ['http://192.168.8.137:8080']);
    assert.equal(verdict.local.pin, formatLocalEnginePin({ serverId: SERVER.id, ownerId: OWNER, origin: ORIGIN }));
    assert.equal(verdict.local.model, 'gpt-oss-20b');
    assert.deepEqual(state.resolved, [SERVER.baseUrl]);

    assert.equal(env.ANTHROPIC_BASE_URL, ORIGIN);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, 'sk-local');
    assert.equal(env.ANTHROPIC_API_KEY, '');
    for (const key of ['ANTHROPIC_MODEL', 'ANTHROPIC_DEFAULT_MODEL', 'ANTHROPIC_DEFAULT_OPUS_MODEL',
      'ANTHROPIC_DEFAULT_SONNET_MODEL', 'ANTHROPIC_DEFAULT_HAIKU_MODEL', 'ANTHROPIC_DEFAULT_FABLE_MODEL',
      'ANTHROPIC_SMALL_FAST_MODEL', 'CLAUDE_CODE_SUBAGENT_MODEL', 'CLAUDE_CODE_AUTO_MODE_MODEL',
      'CLAUDE_CODE_BG_CLASSIFIER_MODEL']) {
      assert.equal(env[key], 'gpt-oss-20b', key);
    }
    assert.equal(env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC, '1');
    assert.equal(env.CLAUDE_CODE_DISABLE_OFFICIAL_MARKETPLACE_AUTOINSTALL, '1');
    assert.equal(env.CLAUDE_CODE_PLUGIN_USE_ZIP_CACHE, '1', 'no marketplace git clone on a local run');
    assert.equal(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS, '32768');
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(CLAUDE_LOCAL_OUTPUT_CAP_TOKENS));
    assert.equal(env.CLAUDE_CODE_ATTRIBUTION_HEADER, '0');
    assert.equal(env.API_TIMEOUT_MS, '600000');
    assert.equal(env.CLAUDE_CODE_USE_BEDROCK, undefined);
    assert.equal(env.ANTHROPIC_UNIX_SOCKET, undefined);
    assert.equal(env.HOME, '/home/user');
  });

  it('uses the placeholder token when the server has no key, and keeps an operator timeout', async () => {
    state.secret = null;
    const env = { API_TIMEOUT_MS: '900000' };
    await apply({ requestedModel: MODEL }, env);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, LOCAL_NO_KEY_PLACEHOLDER);
    assert.equal(env.API_TIMEOUT_MS, '900000');
  });

  it("lowers the output cap to the owner's maxOutput", async () => {
    const env = {};
    await apply({ requestedModel: `${SERVER.providerId}/qwen3.6-35b` }, env);
    assert.equal(env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, '2048');
  });

  it("a pinned session resumes on the pinned server's requested or default model", async () => {
    const storedPin = formatLocalEnginePin({ serverId: SERVER.id, ownerId: OWNER, origin: ORIGIN });
    const env = {};
    assert.equal((await apply({ storedPin }, env)).status, 'applied');
    assert.equal(env.ANTHROPIC_MODEL, 'gpt-oss-20b', 'default = first catalogued model');
    const chosen = {};
    await apply({ storedPin, requestedModel: `${SERVER.providerId}/qwen3.6-35b` }, chosen);
    assert.equal(chosen.ANTHROPIC_MODEL, 'qwen3.6-35b');
  });

  it('nothing is requested -> none, env untouched', async () => {
    const env = { A: '1' };
    assert.deepEqual(await apply({ requestedModel: 'claude-opus-5' }, env), { status: 'none' });
    assert.deepEqual(env, { A: '1' });
  });
});

describe('refusals leave the env untouched', () => {
  const cases = [
    ['feature off', () => { state.enabled = false; }, { requestedModel: MODEL }, 'feature_disabled'],
    ['credential grant in force', () => { state.runnable = false; }, { requestedModel: MODEL }, 'grant_not_supported'],
    ['unknown server', () => { state.servers = []; }, { requestedModel: MODEL }, 'server_not_found'],
    ['unknown model', () => {}, { requestedModel: `${SERVER.providerId}/nope` }, 'model_not_found'],
    ['unknown window', () => {}, { requestedModel: `${SERVER.providerId}/no-window` }, 'context_unknown'],
    ['small window', () => {}, { requestedModel: `${SERVER.providerId}/tiny` }, 'context_too_small'],
    ['claude-* id', () => {}, { requestedModel: `${SERVER.providerId}/Claude-sneaky` }, 'model_id_reserved'],
    ['public address', () => { state.resolveError = Object.assign(new Error('x'), { code: 'local_model_address_forbidden' }); },
      { requestedModel: MODEL }, 'address_not_private'],
    ['path prefix', () => { state.servers = [{ ...SERVER, baseUrl: 'http://192.168.8.137:8080/llama/v1' }]; },
      { requestedModel: MODEL }, 'base_url_unsupported'],
  ];
  for (const [name, arrange, input, reason] of cases) {
    it(name, async () => {
      arrange();
      const env = { KEEP: 'me' };
      assert.deepEqual(await apply(input, env), { status: 'unavailable', provider: 'local', reason });
      assert.deepEqual(env, { KEEP: 'me' });
    });
  }

  it('a pin owned by someone else, a moved server or a foreign model are refused', async () => {
    const storedPin = formatLocalEnginePin({ serverId: SERVER.id, ownerId: OWNER, origin: ORIGIN });
    const foreign = formatLocalEnginePin({ serverId: SERVER.id, ownerId: 99, origin: ORIGIN });
    assert.equal((await apply({ storedPin: foreign })).reason, 'owner_mismatch');
    assert.equal((await applyClaudeLocalEngineEnv({}, { userId: 99, storedPin }, deps())).reason, 'owner_mismatch');
    const moved = formatLocalEnginePin({ serverId: SERVER.id, ownerId: OWNER, origin: 'http://192.168.8.138:8080' });
    assert.equal((await apply({ storedPin: moved })).reason, 'origin_changed');
    assert.equal((await apply({ storedPin, requestedModel: 'claude-opus-5' })).reason, 'pin_conflict');
    assert.equal((await apply({ storedPin, requestedModel: 'nassaj_local_other/gpt-oss-20b' })).reason, 'pin_conflict');
  });

  it('OrThrow raises the typed refusal and never falls back', async () => {
    state.servers = [];
    await assert.rejects(
      applyClaudeLocalEngineEnvOrThrow({}, { userId: OWNER, requestedModel: MODEL }, deps()),
      (error) => error.code === 'ENGINE_PROVIDER_UNAVAILABLE' && error.engineProvider === 'local'
        && error.reason === 'server_not_found',
    );
  });
});

it('the minimum window is the measured base prompt + output cap + margin', () => {
  assert.equal(CLAUDE_LOCAL_BASE_PROMPT_TOKENS, 12000);
  assert.equal(CLAUDE_LOCAL_CONTEXT_MARGIN_TOKENS, 2000);
  assert.equal(minimumClaudeLocalContextWindow(4096), 18096);
  assert.equal(minimumClaudeLocalContextWindow(1024), 15024);
});
