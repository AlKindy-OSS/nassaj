/**
 * resolve-provider-env.test.ts — vendor (kimi/deepseek/glm) key injection + the
 * IRON RULE positive assertions (B-VR-2B / C-VR-7).
 *
 * This complements isolation.e2e.test.ts (which covers the first-party CLI
 * CONFIG_DIR/HOME overrides). Here we prove the OPPOSITE isolation shape used by
 * hosted vendors: resolveProviderEnv fetches the per-user key from the encrypted
 * secrets store and injects it as the provider's own env VALUE, and — the load-
 * bearing guarantee — never sets any key under the ANTHROPIC or CLAUDE namespace.
 *
 * Bootstrap mirrors isolation.e2e.test.ts: a sandboxed $HOME (honored by
 * os.homedir on this platform) and a throwaway DB opened before importing any
 * project module, plus a pinned NASSAJ_PROVIDER_SECRETS_KEY so the secrets store
 * encrypts deterministically. Runner: node:test + node:assert/strict (no vitest).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-resolve-env-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;

const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('../provider-sharing.js');
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { setProviderKey, _resetProviderSecretsServerKeyCache } = await import('./provider-secrets-store.js');
// KIMI_CODE_HOME's root is asserted from the SAME shared constant the production code
// reads (provision-user-dirs.js), not a duplicated literal — so this test can never
// pass against a drifted name (the .kimi vs .kimi-code bug this fix closes).
const { KIMI_HOME_SUBDIR } = await import('./provision-user-dirs.js');

await initializeDatabase();

/** Force the vendor providers isolated (their default) for deterministic runs. */
function isolateVendors(): void {
  _resetProviderSharingCache();
  setProviderSharingConfig({ kimi: 'isolated', deepseek: 'isolated', glm: 'isolated' });
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  _resetProviderSecretsServerKeyCache();
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const VENDOR_KEY_ENV: Record<string, string> = {
  kimi: 'KIMI_API_KEY',
  deepseek: 'DEEPSEEK_API_KEY',
  glm: 'GLM_API_KEY',
};

/** Asserts an env carries no key under the ANTHROPIC or CLAUDE namespace. */
function assertNoAnthropicNamespace(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    assert.ok(
      !/^ANTHROPIC_/.test(name) && !/^CLAUDE_/.test(name),
      `iron rule: env must not contain "${name}"`,
    );
  }
}

describe('resolveProviderEnv — hosted vendor key injection', () => {
  for (const provider of ['kimi', 'deepseek', 'glm'] as const) {
    it(`injects ${VENDOR_KEY_ENV[provider]} from the per-user store`, () => {
      isolateVendors();
      _resetProviderSecretsServerKeyCache();
      setProviderKey(100, provider, `sk-${provider}-live`);

      const env = resolveProviderEnv(100, provider, { PATH: '/usr/bin' });
      assert.equal(env[VENDOR_KEY_ENV[provider]], `sk-${provider}-live`);
    });

    it(`${provider}: never sets any ANTHROPIC_*/CLAUDE_* var (IRON RULE)`, () => {
      isolateVendors();
      _resetProviderSecretsServerKeyCache();
      setProviderKey(100, provider, `sk-${provider}-live`);

      const env = resolveProviderEnv(100, provider, { PATH: '/usr/bin' });
      assertNoAnthropicNamespace(env);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    });
  }

  it('does not inject a key for a user that has none (absence is no-op)', () => {
    isolateVendors();
    _resetProviderSecretsServerKeyCache();
    // user 200 has no stored key
    const env = resolveProviderEnv(200, 'kimi', { PATH: '/usr/bin' });
    assert.equal(env.KIMI_API_KEY, undefined);
  });

  it('per-user isolation: two users get only their own injected key', () => {
    isolateVendors();
    _resetProviderSecretsServerKeyCache();
    setProviderKey(301, 'deepseek', 'sk-user301');
    setProviderKey(302, 'deepseek', 'sk-user302');

    const env301 = resolveProviderEnv(301, 'deepseek', { PATH: '/usr/bin' });
    const env302 = resolveProviderEnv(302, 'deepseek', { PATH: '/usr/bin' });

    assert.equal(env301.DEEPSEEK_API_KEY, 'sk-user301');
    assert.equal(env302.DEEPSEEK_API_KEY, 'sk-user302');
    assert.notEqual(env301.DEEPSEEK_API_KEY, env302.DEEPSEEK_API_KEY);
  });

  it('anonymous (null userId) vendor spawn injects nothing', () => {
    isolateVendors();
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = resolveProviderEnv(null, 'kimi', { ...base });
    assert.deepEqual(env, base);
    assert.equal(env.KIMI_API_KEY, undefined);
  });
});

describe('resolveProviderEnv — opencode XDG isolation (OC-07)', () => {
  const XDG_KEYS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;

  it('shared mode (default): base env is returned byte-for-byte unchanged', () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ opencode: 'shared' });
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = resolveProviderEnv(400, 'opencode', { ...base });
    assert.deepEqual(env, base);
    for (const key of XDG_KEYS) {
      assert.equal(env[key], undefined, `${key} must not be set in shared mode`);
    }
  });

  it('isolated: redirects all four XDG_* dirs into the per-user tree', () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ opencode: 'isolated' });
    const env = resolveProviderEnv(401, 'opencode', { PATH: '/usr/bin' });

    const userRoot = path.join(sandboxHome, '.nassaj-users', '401');
    assert.equal(env.XDG_DATA_HOME, path.join(userRoot, '.local/share'));
    assert.equal(env.XDG_CONFIG_HOME, path.join(userRoot, '.config'));
    assert.equal(env.XDG_CACHE_HOME, path.join(userRoot, '.cache'));
    assert.equal(env.XDG_STATE_HOME, path.join(userRoot, '.local/state'));
    // HOME is NOT overridden for opencode (shared ~/.claude/skills stays reachable).
    assert.equal(env.HOME, undefined);
  });

  it('isolated: never sets any ANTHROPIC_*/CLAUDE_* var (IRON RULE)', () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ opencode: 'isolated' });
    const env = resolveProviderEnv(402, 'opencode', { PATH: '/usr/bin' });
    assertNoAnthropicNamespace(env);
  });

  it('anonymous (null userId) opencode spawn injects nothing even when isolated', () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ opencode: 'isolated' });
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    const env = resolveProviderEnv(null, 'opencode', { ...base });
    assert.deepEqual(env, base);
  });
});

/**
 * SL-5 / ADR-062 regression — the new `mode` parameter must be a strict
 * superset that changes NOTHING for any pre-existing provider branch. Every
 * provider resolveProviderEnv knows about is exercised here (not just kimi):
 * the seam is shared by ALL of them (ADR-014), so a signature change is only
 * safe if the default (chat) path is byte-for-byte identical to the legacy
 * 3-arg call, and mode is a pure no-op everywhere except kimi's agent path.
 */
describe('SL-5 — mode parameter is backward-compatible across ALL providers', () => {
  const BASE: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

  /** Full policy isolating every CLI so we exercise each isolated branch. */
  function isolateAll(): void {
    _resetProviderSharingCache();
    setProviderSharingConfig({
      claude: 'isolated',
      gemini: 'isolated',
      codex: 'isolated',
      agy: 'isolated',
      opencode: 'isolated',
      kimi: 'isolated',
      deepseek: 'isolated',
      glm: 'isolated',
    });
  }

  /** Absolute per-user config subtree, mirroring userConfigDir under the sandbox. */
  function userDir(uid: number, sub = ''): string {
    const root = path.join(sandboxHome, '.nassaj-users', String(uid));
    return sub ? path.join(root, sub) : root;
  }

  // Every provider EXCEPT kimi must be totally mode-agnostic: the env produced
  // by the legacy 3-arg call, by mode='chat', and by mode='agent' are identical.
  const MODE_AGNOSTIC = ['claude', 'gemini', 'codex', 'agy', 'opencode', 'deepseek', 'glm'] as const;
  for (const provider of MODE_AGNOSTIC) {
    it(`${provider}: legacy 3-arg === mode 'chat' === mode 'agent' (mode is a no-op)`, () => {
      isolateAll();
      _resetProviderSecretsServerKeyCache();
      const uid = 500;

      const legacy = resolveProviderEnv(uid, provider, { ...BASE });
      const chat = resolveProviderEnv(uid, provider, { ...BASE }, 'chat');
      const agent = resolveProviderEnv(uid, provider, { ...BASE }, 'agent');

      assert.deepEqual(chat, legacy, `${provider}: mode 'chat' must equal legacy`);
      assert.deepEqual(agent, legacy, `${provider}: mode 'agent' must equal legacy`);
      // And crucially, none of them ever leak a kimi config-home.
      assert.equal(legacy.KIMI_CODE_HOME, undefined);
      assert.equal(agent.KIMI_CODE_HOME, undefined);
    });
  }

  it('first-party CLI overrides are unchanged (claude/gemini/codex/agy)', () => {
    isolateAll();
    const uid = 501;
    assert.equal(
      resolveProviderEnv(uid, 'claude', { ...BASE }).CLAUDE_CONFIG_DIR,
      userDir(uid, '.claude'),
    );
    assert.equal(
      resolveProviderEnv(uid, 'gemini', { ...BASE }).GEMINI_CLI_HOME,
      userDir(uid),
    );
    assert.equal(
      resolveProviderEnv(uid, 'codex', { ...BASE }).CODEX_HOME,
      userDir(uid, '.codex'),
    );
    assert.equal(resolveProviderEnv(uid, 'agy', { ...BASE }).HOME, userDir(uid));
  });

  it('deepseek/glm never get KIMI_CODE_HOME even in agent mode', () => {
    isolateAll();
    _resetProviderSecretsServerKeyCache();
    setProviderKey(502, 'deepseek', 'sk-ds');
    setProviderKey(502, 'glm', 'sk-glm');

    const ds = resolveProviderEnv(502, 'deepseek', { ...BASE }, 'agent');
    const glm = resolveProviderEnv(502, 'glm', { ...BASE }, 'agent');
    assert.equal(ds.DEEPSEEK_API_KEY, 'sk-ds');
    assert.equal(ds.KIMI_CODE_HOME, undefined);
    assert.equal(glm.GLM_API_KEY, 'sk-glm');
    assert.equal(glm.KIMI_CODE_HOME, undefined);
  });

  // Shared-by-policy (cursor) and unknown-to-policy (hermes) providers return the
  // base env unchanged in EVERY mode — mode must never turn a shared provider on.
  for (const provider of ['cursor', 'hermes'] as const) {
    it(`${provider}: base env returned unchanged in every mode`, () => {
      isolateAll();
      assert.deepEqual(resolveProviderEnv(503, provider, { ...BASE }), BASE);
      assert.deepEqual(resolveProviderEnv(503, provider, { ...BASE }, 'chat'), BASE);
      assert.deepEqual(resolveProviderEnv(503, provider, { ...BASE }, 'agent'), BASE);
    });
  }
});

/**
 * SL-5 / ADR-062 — the ONE new behavior: kimi in agent mode gets an isolated
 * KIMI_CODE_HOME on top of its API-key injection, while chat mode (the default)
 * stays exactly as before (key only, no config-home).
 */
describe('SL-5 — kimi agent-mode config-home isolation (KIMI_CODE_HOME)', () => {
  const BASE: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

  function isolateKimi(): void {
    _resetProviderSharingCache();
    setProviderSharingConfig({ kimi: 'isolated' });
    _resetProviderSecretsServerKeyCache();
  }

  function kimiHome(uid: number): string {
    return path.join(sandboxHome, '.nassaj-users', String(uid), KIMI_HOME_SUBDIR);
  }

  it("agent mode: sets KIMI_CODE_HOME to ~/.nassaj-users/<uid>/.kimi", () => {
    isolateKimi();
    setProviderKey(600, 'kimi', 'sk-kimi-live');
    const env = resolveProviderEnv(600, 'kimi', { ...BASE }, 'agent');
    assert.equal(env.KIMI_CODE_HOME, kimiHome(600));
    // The API key is STILL injected in agent mode (native CLI reads it).
    assert.equal(env.KIMI_API_KEY, 'sk-kimi-live');
  });

  it('agent mode sets config-home even when the user has no stored key (OAuth path)', () => {
    isolateKimi();
    const env = resolveProviderEnv(601, 'kimi', { ...BASE }, 'agent');
    assert.equal(env.KIMI_CODE_HOME, kimiHome(601));
    assert.equal(env.KIMI_API_KEY, undefined);
  });

  it('chat mode (default) NEVER sets KIMI_CODE_HOME — legacy behavior preserved', () => {
    isolateKimi();
    setProviderKey(602, 'kimi', 'sk-kimi-live');
    const legacy = resolveProviderEnv(602, 'kimi', { ...BASE });
    const chat = resolveProviderEnv(602, 'kimi', { ...BASE }, 'chat');
    assert.equal(legacy.KIMI_CODE_HOME, undefined);
    assert.equal(chat.KIMI_CODE_HOME, undefined);
    assert.equal(legacy.KIMI_API_KEY, 'sk-kimi-live');
    assert.deepEqual(chat, legacy);
  });

  it('agent mode: per-user config-home isolation (two users never collide)', () => {
    isolateKimi();
    const a = resolveProviderEnv(701, 'kimi', { ...BASE }, 'agent');
    const b = resolveProviderEnv(702, 'kimi', { ...BASE }, 'agent');
    assert.equal(a.KIMI_CODE_HOME, kimiHome(701));
    assert.equal(b.KIMI_CODE_HOME, kimiHome(702));
    assert.notEqual(a.KIMI_CODE_HOME, b.KIMI_CODE_HOME);
  });

  it('agent mode: KIMI_CODE_HOME is outside the ANTHROPIC/CLAUDE namespace (IRON RULE)', () => {
    isolateKimi();
    setProviderKey(603, 'kimi', 'sk-kimi-live');
    const env = resolveProviderEnv(603, 'kimi', { ...BASE }, 'agent');
    assertNoAnthropicNamespace(env);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
  });

  it('anonymous (null userId) kimi agent spawn sets nothing (fail-open shared)', () => {
    isolateKimi();
    const env = resolveProviderEnv(null, 'kimi', { ...BASE }, 'agent');
    assert.deepEqual(env, BASE);
    assert.equal(env.KIMI_CODE_HOME, undefined);
  });

  it('shared policy: kimi agent mode returns base env unchanged (no config-home)', () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ kimi: 'shared' });
    const env = resolveProviderEnv(604, 'kimi', { ...BASE }, 'agent');
    assert.deepEqual(env, BASE);
    assert.equal(env.KIMI_CODE_HOME, undefined);
  });
});
