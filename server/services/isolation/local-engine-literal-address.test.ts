/**
 * ADR-227 Decision 5 / T-2098 qa item 1 (sh3, DNS rebinding): nassaj resolves the
 * registered host ONCE at spawn, requires every answer to be private, and hands
 * the CLI the vetted literal address — the CLI never resolves a name. The pin
 * stays on the registered origin; https by name is refused (certificate checks
 * need the name), https to a literal IP is accepted.
 */
import assert from 'node:assert/strict';
import { beforeEach, describe, it } from 'node:test';

import { resolvePrivateLocalModelAddress } from '../../modules/connectors/index.js';

import { applyClaudeLocalEngineEnv } from './apply-claude-local-engine-env.js';
import { formatLocalEnginePin } from './local-engine-pin.js';

const OWNER = 7;
const ID = '0b9c6a3e-6f1e-4c41-9a4e-2f1b9e0c7d11';
const PROVIDER = 'nassaj_local_0b9c6a3e6f1e4c419a4e2f1b9e0c7d11';
const MODEL = `${PROVIDER}/gpt-oss-20b`;
type Answer = { address: string; family: 4 | 6 };

let state: { baseUrl: string; resolved: Answer | null; calls: number; verifiedAddresses: string[] };
const server = () => ({
  id: ID, ownerId: OWNER, providerId: PROVIDER, baseUrl: state.baseUrl, verifiedAddresses: state.verifiedAddresses,
  models: [{ id: 'gpt-oss-20b', contextWindow: 32768 }],
});
const deps = (resolvePrivate?: (url: string) => Promise<unknown>) => ({
  enabled: () => true,
  runnable: () => true,
  listServers: () => [server()],
  getSecret: () => null,
  resolvePrivate: resolvePrivate ?? (async () => { state.calls += 1; return state.resolved; }),
  cliVersionProven: () => true,
});
const apply = (env: NodeJS.ProcessEnv = {}, extra: Record<string, unknown> = {}, d = deps()) =>
  applyClaudeLocalEngineEnv(env, { userId: OWNER, requestedModel: MODEL, ...extra }, d);

beforeEach(() => {
  state = { baseUrl: 'http://llama.lan:8080/v1', resolved: { address: '192.168.8.137', family: 4 }, calls: 0,
    verifiedAddresses: ['192.168.8.137'] };
});

describe('the CLI receives the vetted literal address, never the name', () => {
  it('IPv4: base URL and authorized origin are the literal; the pin stays on the registered origin', async () => {
    const env: NodeJS.ProcessEnv = {};
    const verdict = await apply(env);
    assert.equal(verdict.status, 'applied');
    if (verdict.status !== 'applied') return;
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://192.168.8.137:8080');
    assert.deepEqual([...verdict.origins], ['http://192.168.8.137:8080']);
    assert.equal(verdict.local.origin, 'http://llama.lan:8080');
    assert.equal(verdict.local.pin, formatLocalEnginePin({ serverId: ID, ownerId: OWNER, origin: 'http://llama.lan:8080' }));
    assert.equal(verdict.local.address, '192.168.8.137');
    assert.ok(!JSON.stringify(env).includes('llama.lan'), 'the name never reaches the child env');
  });

  it('IPv6: the literal is bracketed', async () => {
    state.resolved = { address: 'fd7a:115c:a1e0::1', family: 6 };
    state.verifiedAddresses = ['fd7a:115c:a1e0::1'];
    const env: NodeJS.ProcessEnv = {};
    const verdict = await apply(env);
    assert.equal(verdict.status, 'applied');
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://[fd7a:115c:a1e0::1]:8080');
    if (verdict.status === 'applied') assert.deepEqual([...verdict.origins], ['http://[fd7a:115c:a1e0::1]:8080']);
  });

  it('a default port stays implicit and still matches the authorized origin', async () => {
    state.baseUrl = 'http://llama.lan/v1';
    const env: NodeJS.ProcessEnv = {};
    const verdict = await apply(env);
    assert.equal(env.ANTHROPIC_BASE_URL, 'http://192.168.8.137');
    if (verdict.status === 'applied') assert.deepEqual([...verdict.origins], ['http://192.168.8.137:80']);
  });

  it('https by name is refused before any lookup; https to a literal IP is accepted', async () => {
    state.baseUrl = 'https://llama.lan:8443/v1';
    const env: NodeJS.ProcessEnv = { KEEP: '1' };
    assert.deepEqual(await apply(env), { status: 'unavailable', provider: 'local', reason: 'tls_name_requires_relay' });
    assert.equal(state.calls, 0);
    assert.deepEqual(env, { KEEP: '1' });

    state.baseUrl = 'https://192.168.8.137:8443/v1';
    const ok: NodeJS.ProcessEnv = {};
    assert.equal((await apply(ok)).status, 'applied');
    assert.equal(ok.ANTHROPIC_BASE_URL, 'https://192.168.8.137:8443');
  });

  it('a resolver result that is not an IP literal is refused', async () => {
    for (const bad of [null, {}, { address: 'llama.lan', family: 4 }, { address: '192.168.8.137', family: 6 }]) {
      state.resolved = bad as Answer | null;
      const verdict = await apply();
      assert.equal(verdict.status === 'unavailable' && verdict.reason, 'address_not_private', JSON.stringify(bad));
    }
  });
});

describe('DNS rebinding against the real resolver gate', () => {
  const realGate = (answers: () => Answer[]) => deps((url) => resolvePrivateLocalModelAddress(url, {
    resolver: async () => answers(),
  }));

  it('a name that answers private, then public: the spawn carries the private literal; the next spawn is refused', async () => {
    let call = 0;
    const d = realGate(() => (call++ === 0 ? [{ address: '192.168.8.137', family: 4 }] : [{ address: '203.0.113.7', family: 4 }]));
    const first: NodeJS.ProcessEnv = {};
    assert.equal((await apply(first, {}, d)).status, 'applied');
    assert.equal(first.ANTHROPIC_BASE_URL, 'http://192.168.8.137:8080', 'the CLI has nothing left to re-resolve');
    const second: NodeJS.ProcessEnv = {};
    const verdict = await apply(second, {}, d);
    assert.equal(verdict.status === 'unavailable' && verdict.reason, 'address_not_private');
    assert.equal(second.ANTHROPIC_BASE_URL, undefined);
  });

  it('a mixed private+public answer set is refused', async () => {
    const d = realGate(() => [{ address: '192.168.8.137', family: 4 }, { address: '203.0.113.7', family: 4 }]);
    const verdict = await apply({}, {}, d);
    assert.equal(verdict.status === 'unavailable' && verdict.reason, 'address_not_private');
  });
});
