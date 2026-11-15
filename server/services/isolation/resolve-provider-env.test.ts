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
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { SYSTEM_ACTOR } = await import('./credential-actor.js');
const { setProviderKey, _resetProviderSecretsServerKeyCache } = await import('./provider-secrets-store.js');

await initializeDatabase();

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
      _resetProviderSecretsServerKeyCache();
      setProviderKey(100, provider, `sk-${provider}-live`);

      const env = resolveProviderEnv(100, provider, { PATH: '/usr/bin' });
      assert.equal(env[VENDOR_KEY_ENV[provider]], `sk-${provider}-live`);
    });

    it(`${provider}: never sets any ANTHROPIC_*/CLAUDE_* var (IRON RULE)`, () => {
      _resetProviderSecretsServerKeyCache();
      setProviderKey(100, provider, `sk-${provider}-live`);

      const env = resolveProviderEnv(100, provider, { PATH: '/usr/bin' });
      assertNoAnthropicNamespace(env);
      assert.equal(env.ANTHROPIC_BASE_URL, undefined);
      assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    });
  }

  it('does not inject a key for a user that has none (absence is no-op)', () => {
    _resetProviderSecretsServerKeyCache();
    // user 200 has no stored key
    const env = resolveProviderEnv(200, 'kimi', { PATH: '/usr/bin' });
    assert.equal(env.KIMI_API_KEY, undefined);
  });

  it('per-user isolation: two users get only their own injected key', () => {
    _resetProviderSecretsServerKeyCache();
    setProviderKey(301, 'deepseek', 'sk-user301');
    setProviderKey(302, 'deepseek', 'sk-user302');

    const env301 = resolveProviderEnv(301, 'deepseek', { PATH: '/usr/bin' });
    const env302 = resolveProviderEnv(302, 'deepseek', { PATH: '/usr/bin' });

    assert.equal(env301.DEEPSEEK_API_KEY, 'sk-user301');
    assert.equal(env302.DEEPSEEK_API_KEY, 'sk-user302');
    assert.notEqual(env301.DEEPSEEK_API_KEY, env302.DEEPSEEK_API_KEY);
  });

  it('a null actor is refused; the system actor gets no vendor key', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    assert.throws(() => resolveProviderEnv(null, 'kimi', { ...base }), { code: 'CREDENTIAL_ACTOR_REQUIRED' });
    const env = resolveProviderEnv(SYSTEM_ACTOR as never, 'kimi', { ...base });
    assert.equal(env.KIMI_API_KEY, undefined);
    assert.equal(env.KIMI_CODE_NO_AUTO_UPDATE, undefined, 'the kimi CLI is removed (ADR-229): no updater switch');
  });
});

describe('resolveProviderEnv — opencode XDG isolation (OC-07)', () => {
  const XDG_KEYS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_STATE_HOME'] as const;

  it('a member never inherits the operator XDG dirs (no shared mode, ADR-152 A1)', () => {
    const operator: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    for (const key of XDG_KEYS) operator[key] = path.join(sandboxHome, `operator-${key}`);
    const env = resolveProviderEnv(400, 'opencode', { ...operator });
    const userRoot = path.join(sandboxHome, '.nassaj-users', '400');
    for (const key of XDG_KEYS) {
      assert.ok(env[key]?.startsWith(userRoot), `${key}=${env[key]} must be the member's tree`);
    }
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  });

  it('isolated: redirects all four XDG_* dirs into the per-user tree', () => {
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
    const env = resolveProviderEnv(402, 'opencode', { PATH: '/usr/bin' });
    assertNoAnthropicNamespace(env);
  });

  it('a system-actor opencode spawn still disables the binary updater', () => {
    const env = resolveProviderEnv(SYSTEM_ACTOR as never, 'opencode', { PATH: '/usr/bin' });
    assert.equal(env.OPENCODE_DISABLE_AUTOUPDATE, '1');
  });
});

describe('resolveProviderEnv — the server working directory never reaches a child (B-1715)', () => {
  it('drops PWD/OLDPWD for members and the system actor, every provider and mode', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', PWD: '/srv/live-root', OLDPWD: '/srv' };
    for (const provider of ['opencode', 'claude', 'codex', 'kimi'] as const) {
      for (const [actor, mode] of [[410, 'chat'], [411, 'agent'], [SYSTEM_ACTOR, 'chat']] as const) {
        const env = resolveProviderEnv(actor as never, provider, { ...base }, mode);
        assert.equal(env.PWD, undefined, `${provider}/${String(actor)}/${mode}`);
        assert.equal(env.OLDPWD, undefined, `${provider}/${String(actor)}/${mode}`);
        assert.equal(env.PATH, '/usr/bin');
      }
    }
  });

  it('never mutates the base env it was given', () => {
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', PWD: '/srv/live-root' };
    resolveProviderEnv(SYSTEM_ACTOR as never, 'opencode', base);
    assert.equal(base.PWD, '/srv/live-root');
  });
});

describe('resolveProviderEnv — updater policy covers every identity mode', () => {
  it('claude anonymous and member modes all disable self-update', () => {
    for (const userId of [SYSTEM_ACTOR, 44, 45]) {
      assert.equal(resolveProviderEnv(userId as never, 'claude', { PATH: '/usr/bin' }).DISABLE_AUTOUPDATER, '1');
    }
  });
});

/**
 * SL-5 / ADR-062 regression — the new `mode` parameter must be a strict
 * superset that changes NOTHING for any pre-existing provider branch. Every
 * provider resolveProviderEnv knows about is exercised here: the seam is shared
 * by ALL of them (ADR-014), so a signature change is only safe if the default
 * (chat) path is byte-for-byte identical to the legacy 3-arg call, and mode is a
 * pure no-op everywhere except opencode's carrier sanitize. The kimi agent
 * branch (KIMI_CODE_HOME) was removed with the kimi native body (ADR-229).
 */
describe('SL-5 — mode parameter is backward-compatible across ALL providers', () => {
  const BASE: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

  /** Absolute per-user config subtree, mirroring userConfigDir under the sandbox. */
  function userDir(uid: number, sub = ''): string {
    const root = path.join(sandboxHome, '.nassaj-users', String(uid));
    return sub ? path.join(root, sub) : root;
  }

  // These providers are totally mode-agnostic: the env produced by the legacy
  // 3-arg call, by mode='chat', and by mode='agent' are identical.
  const MODE_AGNOSTIC = [
    'claude', 'codex', 'agy', 'opencode', 'kimi', 'deepseek', 'glm', 'qwen',
  ] as const;
  for (const provider of MODE_AGNOSTIC) {
    it(`${provider}: legacy 3-arg === mode 'chat' === mode 'agent' (mode is a no-op)`, () => {
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

  it('first-party CLI overrides are unchanged (claude/codex/agy)', () => {
    const uid = 501;
    assert.equal(
      resolveProviderEnv(uid, 'claude', { ...BASE }).CLAUDE_CONFIG_DIR,
      userDir(uid, '.claude'),
    );
    assert.equal(
      resolveProviderEnv(uid, 'codex', { ...BASE }).CODEX_HOME,
      userDir(uid, '.codex'),
    );
    assert.equal(resolveProviderEnv(uid, 'agy', { ...BASE }).HOME, userDir(uid));
    assert.equal(resolveProviderEnv(uid, 'qwen', { ...BASE }).HOME, userDir(uid));
  });

  it('deepseek/glm never get a KIMI_CODE_HOME even in agent mode', () => {
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

  // ADR-105 — cursor moved OUT of this group. It used to sit here
  // as "returns the base env unchanged", which read like a deliberate policy and
  // was really an absence: cursor had no case, so it inherited the operator's
  // environment in every mode. It now isolates through HOME, like agy.
  it('cursor: HOME is redirected to the user tree in every mode', () => {
    for (const mode of [undefined, 'chat', 'agent'] as const) {
      const env = mode
        ? resolveProviderEnv(503, 'cursor', { ...BASE }, mode)
        : resolveProviderEnv(503, 'cursor', { ...BASE });
      assert.equal(
        env.HOME,
        userDir(503),
        `cursor HOME must point at the user tree (mode=${mode ?? 'default'})`
      );
      // Everything cursor-agent touches — ~/.cursor (login + chats) and its own
      // ~/.local/share/cursor-agent install — hangs off HOME, so one override
      // covers all of them. PATH is deliberately NOT rewritten: the binary lives
      // in the operator's ~/.local/bin and must stay reachable.
      assert.equal(env.PATH, BASE.PATH, 'PATH must be inherited so the CLI is still found');
    }
  });

  // T-1953: the hermes body is deleted, so the id left the isolation policy and
  // is refused like any ungoverned name — it must never fall back to the
  // operator environment, where the operator's hermes credential still sits.
  it('hermes: a deleted body is refused in every mode', () => {
    for (const mode of [undefined, 'chat', 'agent'] as const) {
      assert.throws(
        () =>
          mode
            ? resolveProviderEnv(503, 'hermes' as never, { ...BASE }, mode)
            : resolveProviderEnv(503, 'hermes' as never, { ...BASE }),
        (error: unknown) =>
          (error as { code?: string })?.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
        `a deleted body must be refused (mode=${mode ?? 'default'})`
      );
    }
  });

  // A provider the policy has never heard of is refused, shown with a name that
  // cannot silently become governed later.
  it('an unknown provider is refused rather than run on the operator environment', () => {
    for (const mode of [undefined, 'chat', 'agent'] as const) {
      // Asserted on the CODE, not the message: the message is user-facing prose
      // that will be reworded, while the code is the contract every caller
      // branches on.
      assert.throws(
        () =>
          mode
            ? resolveProviderEnv(503, 'sakana' as never, { ...BASE }, mode)
            : resolveProviderEnv(503, 'sakana' as never, { ...BASE }),
        (error: unknown) =>
          (error as { code?: string })?.code === 'PROVIDER_ISOLATION_UNAVAILABLE',
        `an ungoverned provider must be refused (mode=${mode ?? 'default'})`
      );
    }
  });
});

/**
 * ADR-229 — the kimi native agent body is removed: agent mode no longer adds a
 * KIMI_CODE_HOME; kimi resolves to its key only, like deepseek and glm.
 */
describe('ADR-229 — kimi agent mode is key-only (no KIMI_CODE_HOME)', () => {
  const BASE: NodeJS.ProcessEnv = { PATH: '/usr/bin' };

  it('agent mode injects the key and sets no config-home, for members and the system actor', () => {
    _resetProviderSecretsServerKeyCache();
    setProviderKey(600, 'kimi', 'sk-kimi-live');
    const env = resolveProviderEnv(600, 'kimi', { ...BASE }, 'agent');
    assert.equal(env.KIMI_CODE_HOME, undefined);
    assert.equal(env.KIMI_API_KEY, 'sk-kimi-live');
    assertNoAnthropicNamespace(env);
    assert.equal(resolveProviderEnv(SYSTEM_ACTOR as never, 'kimi', { ...BASE }, 'agent').KIMI_CODE_HOME, undefined);
  });
});

