/**
 * credential-gate.test — ADR-152 amendment 1 §3.5 (T-2083, BE-10/11).
 *
 * The pre-spawn gate admits a model turn only when the credential principal
 * (the member, or a grantor under a usable grant) has a credential PRESENT for
 * the provider. Every KNOWN_PROVIDER has a predicate; a missing predicate, an
 * unknown provider or a model the predicate cannot place is refused. A revoked
 * grant yields `not_linked`; a grant whose owner is not linked yields
 * `grantor_not_linked` with the owner's username (never an email).
 *
 * AT3 (warm session): a reusable live process whose principal changed is
 * terminated before the turn, and the turn is refused.
 *
 * Runner: node:test. Sandboxed $HOME + throwaway DB opened before any import.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-credential-gate-test-'));
const ORIGINAL = {
  HOME: process.env.HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  NASSAJ_PROVIDER_SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
  NASSAJ_OPENCODE_SPAWN_VENDORS: process.env.NASSAJ_OPENCODE_SPAWN_VENDORS,
};
const operatorHome = path.join(sandbox, 'home');
fs.mkdirSync(operatorHome, { recursive: true });
process.env.HOME = operatorHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.NASSAJ_OPENCODE_SPAWN_VENDORS;
assert.equal(os.homedir(), operatorHome);

const { initializeDatabase, closeConnection, credentialGrantsDb, userDb } = await import('@/modules/database/index.js');
const { SYSTEM_ACTOR } = await import('./credential-actor.js');
const { KNOWN_PROVIDERS } = await import('./known-providers.js');
const {
  CREDENTIAL_PREDICATES, assertCredentialLinked, credentialNotLinkedPayload, hasCredentialPredicate, resolveModelRunEnv,
} = await import('./credential-gate.js');
const { _resetProviderSecretsServerKeyCache, setProviderKey } = await import('./provider-secrets-store.js');
const { userConfigDir } = await import('./provision-user-dirs.js');
const {
  WARM_PRINCIPAL_CHANGED, countWarmCredentialProcessesForTests, registerWarmCredentialProcess,
  resetWarmCredentialProcessesForTests,
} = await import('./warm-credential-processes.js');

await initializeDatabase();

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

let seq = 0;
const member = (role = 'user') => userDb.createUser(`gate-${role}-${(seq += 1)}`, 'hash', role);

/** Writes `value` as JSON at `<member tree>/<rel>`. */
function writeTree(userId: number, rel: string, value: unknown): void {
  const file = path.join(userConfigDir(userId, ''), rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value));
}

/** The refusal `fn` throws, asserted to be CREDENTIAL_NOT_LINKED. */
/** The principal part of an admission (it also carries unit and ownOnly). */
const principalOf = (admission: { principalId: number; grantedBy: number | null }) =>
  ({ principalId: admission.principalId, grantedBy: admission.grantedBy });

function refusal(fn: () => unknown): Record<string, any> {
  try {
    fn();
  } catch (error) {
    const payload = credentialNotLinkedPayload(error);
    assert.ok(payload, `expected CREDENTIAL_NOT_LINKED, got ${(error as any)?.code}`);
    assert.equal((error as any).statusCode, 409);
    return payload;
  }
  assert.fail('expected a refusal');
}

/** Each provider's credential, written into a member's own tree or slot. */
const LINK: Record<string, (id: number) => void> = {
  claude: (id) => writeTree(id, '.claude/.credentials.json', { claudeAiOauth: { accessToken: 'sk-ant-oat01-x' } }),
  codex: (id) => writeTree(id, '.codex/auth.json', { tokens: { refresh_token: 'rt' } }),
  agy: (id) => writeTree(id, '.gemini/antigravity-cli/antigravity-oauth-token', { token: { access_token: 'ya29' } }),
  cursor: (id) => writeTree(id, '.config/cursor/auth.json', { accessToken: 'cur' }),
  opencode: (id) => writeTree(id, '.local/share/opencode/auth.json', { anthropic: { type: 'api', key: 'sk' } }),
  kimi: (id) => setProviderKey(id, 'kimi', 'sk-kimi'),
  deepseek: (id) => setProviderKey(id, 'deepseek', 'sk-ds'),
  glm: (id) => setProviderKey(id, 'glm', 'sk-glm'),
  qwen: (id) => setProviderKey(id, 'qwen', JSON.stringify({ plan: 'token_plan', region: 'international', key: 'sk-sp' })),
  dsh: (id) => setProviderKey(id, 'deepseek', 'sk-ds'),
};

beforeEach(() => resetWarmCredentialProcessesForTests());

describe('predicates — every KNOWN_PROVIDER, fail closed', () => {
  it('every known provider has a predicate, and no predicate exists for an unknown one', () => {
    assert.deepEqual(Object.keys(CREDENTIAL_PREDICATES).sort(), [...KNOWN_PROVIDERS].sort());
    for (const provider of KNOWN_PROVIDERS as string[]) assert.ok(hasCredentialPredicate(provider), provider);
    assert.equal(hasCredentialPredicate('hermes'), false);
  });

  for (const provider of KNOWN_PROVIDERS as string[]) {
    it(`${provider}: refused without a credential, admitted on the member's own credential`, () => {
      const user = member();
      const before = refusal(() => assertCredentialLinked({ actor: user.id, provider }));
      assert.equal(before.reason, 'not_linked');
      assert.equal(before.grantorUsername, undefined);
      LINK[provider](user.id);
      assert.deepEqual(principalOf(assertCredentialLinked({ actor: user.id, provider })), { principalId: user.id, grantedBy: null });
    });
  }

  it('claude also accepts a key or token in the member\'s own settings.json, and not an inherited env token', () => {
    for (const key of ['ANTHROPIC_API_KEY', 'ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
      const user = member();
      process.env.CLAUDE_CODE_OAUTH_TOKEN = 'sk-ant-oat01-operator';
      try {
        refusal(() => assertCredentialLinked({ actor: user.id, provider: 'claude' }));
      } finally {
        delete process.env.CLAUDE_CODE_OAUTH_TOKEN;
      }
      writeTree(user.id, '.claude/settings.json', { env: { [key]: 'v' } });
      assert.equal(assertCredentialLinked({ actor: user.id, provider: 'claude' }).principalId, user.id, key);
    }
  });

  it('claude on a vendor engine needs that engine key; an unknown engine is refused', () => {
    const user = member();
    LINK.claude(user.id);
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'claude', engine: 'glm' }));
    setProviderKey(user.id, 'glm', 'sk-glm');
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'claude', engine: 'glm' }).principalId, user.id);
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'claude', engine: 'anthropic' }).principalId, user.id);
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'claude', engine: 'not-an-engine' }));
  });

  it('qa M2: a Claude engine needs the CALLER\'s own engine key, like the run (keyOwner: caller)', () => {
    // (a) a glm grant from a member who holds a glm key does NOT admit a Claude
    //     turn on the glm engine: the run spends the caller's own key only.
    const owner = member('owner');
    const grantee = member();
    LINK.claude(grantee.id);
    setProviderKey(owner.id, 'glm', 'sk-owner-glm');
    credentialGrantsDb.grant(owner.id, grantee.id, 'glm');
    const refused = refusal(() => assertCredentialLinked({ actor: grantee.id, provider: 'claude', engine: 'glm' }));
    assert.equal(refused.reason, 'not_linked');
    assert.equal(refused.provider, 'glm');
    // (b) the caller's own glm key admits it, even under a glm grant from a
    //     member who holds no glm key (the run never consults the grant).
    const bare = member('owner');
    const holder = member();
    setProviderKey(holder.id, 'glm', 'sk-own-glm');
    credentialGrantsDb.grant(bare.id, holder.id, 'glm');
    assert.deepEqual(principalOf(assertCredentialLinked({ actor: holder.id, provider: 'claude', engine: 'glm' })),
      { principalId: holder.id, grantedBy: null });
  });

  it('codex accepts a stored OPENAI_API_KEY', () => {
    const user = member();
    writeTree(user.id, '.codex/auth.json', { OPENAI_API_KEY: 'sk-proj' });
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'codex' }).principalId, user.id);
  });

  it('ADR-229: a leftover native kimi CLI login admits no kimi run in any mode (key slot only)', () => {
    const user = member();
    writeTree(user.id, '.kimi/credentials/kimi-code.json', { access_token: 'kimi-sub' });
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'kimi', mode: 'chat' }));
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'kimi', mode: 'agent' }));
  });

  it('opencode: the model\'s vendor must be in auth.json; free and local models need nothing; a bare model is refused', () => {
    const user = member();
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'anthropic/claude-sonnet' }));
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'opencode/grok-code-free' }).principalId, user.id);
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'nassaj_local_1/llama' }).principalId, user.id);
    LINK.opencode(user.id);
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'anthropic/claude-sonnet' }).principalId, user.id);
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'openai/gpt-5' }));
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'bare-model-id' }));
  });

  it('opencode qwen-plan and spawn-vendor models need the sender\'s OWN slot, never a grant', () => {
    const owner = member('owner');
    const user = member();
    setProviderKey(owner.id, 'deepseek', 'sk-owner-ds');
    credentialGrantsDb.grant(owner.id, user.id, 'deepseek');
    process.env.NASSAJ_OPENCODE_SPAWN_VENDORS = '1';
    try {
      refusal(() => assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'deepseek/deepseek-chat' }));
      setProviderKey(user.id, 'deepseek', 'sk-own-ds');
      assert.deepEqual(principalOf(assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'deepseek/deepseek-chat' })),
        { principalId: user.id, grantedBy: null });
    } finally {
      delete process.env.NASSAJ_OPENCODE_SPAWN_VENDORS;
    }
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'qwen-plan/qwen3-coder-plus' }));
    LINK.qwen(user.id);
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'opencode', model: 'qwen-plan/qwen3-coder-plus' }).principalId, user.id);
  });

  it('an unknown provider is refused, and so are a missing actor and the system actor', () => {
    const user = member();
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'hermes' }));
    assert.throws(() => assertCredentialLinked({ actor: null, provider: 'claude' }), { code: 'CREDENTIAL_ACTOR_REQUIRED' });
    assert.throws(() => assertCredentialLinked({ actor: SYSTEM_ACTOR, provider: 'claude' }), { code: 'CREDENTIAL_ACTOR_REQUIRED' });
  });

  it('accepts the antigravity alias and reports the UI id and settings anchor', () => {
    const user = member();
    const payload = refusal(() => assertCredentialLinked({ actor: user.id, provider: 'antigravity' }));
    assert.equal(payload.provider, 'antigravity');
    assert.equal(payload.settingsAnchor, 'agents/antigravity');
  });
});

describe('grants — the principal decides', () => {
  it('a grantee runs on a linked grantor; an unlinked grantor is named by username; a revoked grant is not_linked', () => {
    const owner = member('owner');
    const ebtehal = member();
    credentialGrantsDb.grant(owner.id, ebtehal.id, 'claude');
    const unlinked = refusal(() => assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' }));
    assert.equal(unlinked.reason, 'grantor_not_linked');
    assert.equal(unlinked.grantorUsername, owner.username);
    assert.ok(!JSON.stringify(unlinked).includes('@'), 'no email in the payload');

    LINK.claude(owner.id);
    assert.deepEqual(principalOf(assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' })), { principalId: owner.id, grantedBy: owner.id });

    credentialGrantsDb.revoke(owner.id, ebtehal.id, 'claude');
    const revoked = refusal(() => assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' }));
    assert.equal(revoked.reason, 'not_linked');
    assert.equal(revoked.grantorUsername, undefined);
  });

  it('honorGrants:false checks the caller\'s own credential only', () => {
    const owner = member('owner');
    const user = member();
    LINK.codex(owner.id);
    credentialGrantsDb.grant(owner.id, user.id, 'codex');
    assert.equal(assertCredentialLinked({ actor: user.id, provider: 'codex' }).grantedBy, owner.id);
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'codex', honorGrants: false }));
  });

  it('qwen is never granted: a grant row for it is ignored', () => {
    const owner = member('owner');
    const user = member();
    LINK.qwen(owner.id);
    credentialGrantsDb.grant(owner.id, user.id, 'qwen');
    refusal(() => assertCredentialLinked({ actor: user.id, provider: 'qwen' }));
  });
});

describe('dsh — the member\'s own deepseek key only (T-2086, ADR-224)', () => {
  it('a deepseek grant never admits a dsh turn, and the refusal names the deepseek slot', () => {
    const owner = member('owner');
    const user = member();
    LINK.deepseek(owner.id);
    credentialGrantsDb.grant(owner.id, user.id, 'deepseek');
    const payload = refusal(() => assertCredentialLinked({ actor: user.id, provider: 'dsh' }));
    assert.equal(payload.provider, 'deepseek');
    assert.equal(payload.settingsAnchor, 'agents/deepseek');
    assert.equal(payload.reason, 'not_linked');
  });

  it('the env carries the member\'s own key and HOME, never the grantor\'s or an inherited one', () => {
    const owner = member('owner');
    const user = member();
    LINK.deepseek(owner.id);
    credentialGrantsDb.grant(owner.id, user.id, 'deepseek');
    setProviderKey(user.id, 'deepseek', 'sk-ds-own');
    const env = resolveModelRunEnv(user.id, 'dsh', { DEEPSEEK_API_KEY: 'sk-operator', XDG_DATA_HOME: '/op' }, 'agent');
    assert.equal(env.DEEPSEEK_API_KEY, 'sk-ds-own');
    assert.equal(env.HOME, userConfigDir(user.id, ''));
    assert.equal(env.XDG_DATA_HOME, undefined);
  });
});

describe('resolveModelRunEnv — gate first, then the environment', () => {
  it('throws CREDENTIAL_ACTOR_REQUIRED for every non-member id (the removed strict wrapper\'s contract)', () => {
    const bad = [null, undefined, '', 'abc', '05', 0, -1, -100, 1.5, NaN, {}, [], true, SYSTEM_ACTOR];
    for (const id of bad) {
      assert.throws(() => resolveModelRunEnv(id as never, 'claude', { HOME: '/x' }), { code: 'CREDENTIAL_ACTOR_REQUIRED' },
        `id=${JSON.stringify(id)}`);
    }
  });

  it('builds the principal\'s environment once admitted, and nothing when refused', () => {
    const owner = member('owner');
    const user = member();
    assert.throws(() => resolveModelRunEnv(user.id, 'codex', { PATH: '/usr/bin' }), { code: 'CREDENTIAL_NOT_LINKED' });
    assert.equal(fs.existsSync(userConfigDir(user.id, '.codex')), false, 'refused before provisioning');
    LINK.codex(owner.id);
    credentialGrantsDb.grant(owner.id, user.id, 'codex');
    const env = resolveModelRunEnv(user.id, 'codex', { PATH: '/usr/bin' });
    assert.equal(env.CODEX_HOME, userConfigDir(owner.id, '.codex'));
  });
});

describe('AT3 — revocation reaches a warm session before the next turn', () => {
  it('a warm process on the revoked grantor is killed before the turn, and the turn is refused', () => {
    const owner = member('owner');
    const ebtehal = member();
    LINK.claude(owner.id);
    credentialGrantsDb.grant(owner.id, ebtehal.id, 'claude');
    const admitted = assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' });
    assert.equal(admitted.principalId, owner.id);

    const killed: string[] = [];
    registerWarmCredentialProcess({
      userId: ebtehal.id, unit: 'claude', principalId: admitted.principalId,
      terminate: (reason) => { killed.push(reason); },
    });
    // While the grant stands, the next admission leaves the warm process alone.
    assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' });
    assert.deepEqual(killed, []);

    credentialGrantsDb.revoke(owner.id, ebtehal.id, 'claude');
    const refused = refusal(() => assertCredentialLinked({ actor: ebtehal.id, provider: 'claude' }));
    assert.equal(refused.reason, 'not_linked');
    assert.deepEqual(killed, [WARM_PRINCIPAL_CHANGED], 'the warm process was terminated before the refusal');
    assert.equal(countWarmCredentialProcessesForTests(), 0);
  });

  it('qa M3: a Claude turn by a grantee does not kill the same member\'s glm-engine warm session', () => {
    const owner = member('owner');
    const grantee = member();
    LINK.claude(owner.id);
    credentialGrantsDb.grant(owner.id, grantee.id, 'claude');
    setProviderKey(grantee.id, 'glm', 'sk-own-glm');
    // The glm-engine Claude run is admitted on the grantee's OWN glm key and
    // registers the way claude-sdk.js does (provider 'claude' + the admission).
    const engineAdmission = assertCredentialLinked({ actor: grantee.id, provider: 'claude', engine: 'glm' });
    const killed: string[] = [];
    registerWarmCredentialProcess({ userId: grantee.id, provider: 'claude', ...engineAdmission,
      terminate: (reason) => { killed.push(reason); } } as never);
    // An official Claude turn by the same member runs on the grantor's tree.
    assert.equal(assertCredentialLinked({ actor: grantee.id, provider: 'claude' }).principalId, owner.id);
    assert.deepEqual(killed, [], 'the glm-engine session is on an unrelated credential unit');
    assert.equal(countWarmCredentialProcessesForTests(), 1);
  });

  it('another member\'s or another provider\'s warm process is untouched', () => {
    const owner = member('owner');
    const a = member();
    const killed: string[] = [];
    registerWarmCredentialProcess({ userId: owner.id, unit: 'claude', principalId: owner.id, terminate: () => killed.push('owner') });
    registerWarmCredentialProcess({ userId: a.id, unit: 'codex', principalId: owner.id, terminate: () => killed.push('codex') });
    refusal(() => assertCredentialLinked({ actor: a.id, provider: 'claude' }));
    assert.deepEqual(killed, []);
    assert.equal(countWarmCredentialProcessesForTests(), 2);
  });
});
