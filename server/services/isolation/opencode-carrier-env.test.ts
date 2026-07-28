/**
 * opencode-carrier-env.test.ts — GL-4 (ADR-062) regression for the OpenCode
 * carrier env sanitization in resolveProviderEnv.
 *
 * GL-4 adds ONE narrow behavior to the shared credential-isolation seam: when
 * opencode is spawned in the GOVERNED CARRIER shape (mode==='agent' — the custom
 * `glm` provider, Anthropic-wire → api.z.ai), the resolved child env is passed
 * through sanitizeVendorAgentEnv (SL-3) as its LAST step, stripping any inherited
 * ANTHROPIC_ / CLAUDE_ namespace, the Claude OAuth token, and intrusive base-URL
 * redirects that could silently route the carrier through the owner's Claude
 * subscription (IRON RULE / ToS). Everything else about opencode — and every other
 * provider and every other opencode mode — must be byte-for-byte identical to the
 * pre-GL-4 behavior.
 *
 * The load-bearing assertions here:
 *   1. carrier (agent) mode STRIPS the inherited anthropic/claude/oauth namespaces
 *      while keeping XDG isolation and the GLM_ key namespace intact.
 *   2. chat / legacy 3-arg opencode is deepEqual to the pre-GL-4 result (the
 *      built-in `anthropic` DEFAULT_TARGET path is NOT broken — inherited
 *      ANTHROPIC_ vars and the CLAUDE_CODE_OAUTH_TOKEN survive because chat mode
 *      never sanitizes).
 *
 * Bootstrap mirrors resolve-provider-env.test.ts: a sandboxed $HOME + throwaway DB
 * + pinned secrets key, imported before any project module. Runner: node:test +
 * node:assert/strict (no vitest).
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { after, describe, it } from 'node:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-oc-carrier-env-test-'));
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

await initializeDatabase();

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

/** Absolute per-user config subtree, mirroring userConfigDir under the sandbox. */
function userDir(uid: number, sub = ''): string {
  const root = path.join(sandboxHome, '.nassaj-users', String(uid));
  return sub ? path.join(root, sub) : root;
}

/** The four XDG base dirs opencode isolation always overrides. */
function xdgOverrides(uid: number): NodeJS.ProcessEnv {
  return {
    XDG_DATA_HOME: userDir(uid, '.local/share'),
    XDG_CONFIG_HOME: userDir(uid, '.config'),
    XDG_CACHE_HOME: userDir(uid, '.cache'),
    XDG_STATE_HOME: userDir(uid, '.local/state'),
  };
}

/** Asserts an env carries no key under the ANTHROPIC or CLAUDE namespace. */
function assertNoAnthropicNamespace(env: NodeJS.ProcessEnv): void {
  for (const name of Object.keys(env)) {
    assert.ok(
      !/^ANTHROPIC_/i.test(name) && !/^CLAUDE_/i.test(name),
      `iron rule: env must not contain "${name}"`,
    );
  }
}

function isolateOpencode(): void {
  _resetProviderSharingCache();
  setProviderSharingConfig({ opencode: 'isolated' });
}

/**
 * A deliberately "dirty" operator env: it carries every sensitive namespace a
 * leaked parent process could pass down. carrier mode must scrub it; chat mode
 * must leave it verbatim (the anthropic DEFAULT_TARGET relies on it).
 */
function dirtyEnv(): NodeJS.ProcessEnv {
  return {
    PATH: '/usr/bin',
    LANG: 'en_US.UTF-8',
    ANTHROPIC_API_KEY: 'sk-ant-operator',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    ANTHROPIC_AUTH_TOKEN: 'ant-auth-operator',
    CLAUDE_CODE_OAUTH_TOKEN: 'oauth-owner-subscription', // THE worst leak
    CLAUDE_CONFIG_DIR: '/home/operator/.claude',
    GITHUB_TOKEN: 'ghp_operator',
    SOME_VENDOR_BASE_URL: 'https://intruder.example', // intrusive *_BASE_URL
    GLM_API_KEY: 'sk-glm-should-survive', // the carrier's own key namespace
  };
}

describe('GL-4 — opencode carrier (agent) mode sanitizes the child env', () => {
  it('strips inherited ANTHROPIC_*/CLAUDE_*/OAuth/*_BASE_URL from the carrier child', () => {
    isolateOpencode();
    const uid = 800;
    const env = resolveProviderEnv(uid, 'opencode', dirtyEnv(), 'agent');

    // Every sensitive namespace is gone.
    assert.equal(env.ANTHROPIC_API_KEY, undefined);
    assert.equal(env.ANTHROPIC_BASE_URL, undefined);
    assert.equal(env.ANTHROPIC_AUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
    assert.equal(env.GITHUB_TOKEN, undefined);
    assert.equal(env.SOME_VENDOR_BASE_URL, undefined);
    assertNoAnthropicNamespace(env);
  });

  it('keeps XDG isolation and the GLM_ key namespace intact in carrier mode', () => {
    isolateOpencode();
    const uid = 801;
    const env = resolveProviderEnv(uid, 'opencode', dirtyEnv(), 'agent');

    // XDG isolation is still applied (sanitize runs AFTER the XDG overrides).
    for (const [k, v] of Object.entries(xdgOverrides(uid))) {
      assert.equal(env[k], v, `${k} must survive sanitize`);
    }
    // Benign + the carrier's own key namespace survive (GLM key comes from
    // auth.json, but if present in env it must NOT be stripped — sanitize keeps
    // KIMI_/DEEPSEEK_/GLM_/ZAI_ deliberately).
    assert.equal(env.PATH, '/usr/bin');
    assert.equal(env.LANG, 'en_US.UTF-8');
    assert.equal(env.GLM_API_KEY, 'sk-glm-should-survive');
  });

  it('carrier mode produces a STRICTLY different env than chat mode (GL-4 is active)', () => {
    isolateOpencode();
    const uid = 802;
    const agent = resolveProviderEnv(uid, 'opencode', dirtyEnv(), 'agent');
    const chat = resolveProviderEnv(uid, 'opencode', dirtyEnv(), 'chat');
    assert.notDeepEqual(agent, chat);
  });
});

describe('GL-4 — opencode chat/legacy is byte-for-byte pre-GL-4 (anthropic target intact)', () => {
  it("legacy 3-arg === mode 'chat' and equals the exact pre-GL-4 result", () => {
    isolateOpencode();
    const uid = 810;

    const legacy = resolveProviderEnv(uid, 'opencode', dirtyEnv());
    const chat = resolveProviderEnv(uid, 'opencode', dirtyEnv(), 'chat');

    // The pre-GL-4 result: base env spread verbatim + the four XDG overrides,
    // with NOTHING stripped. Hand-built so a future accidental sanitize in chat
    // mode is caught.
    const expected: NodeJS.ProcessEnv = { ...dirtyEnv(), ...xdgOverrides(uid) };

    assert.deepEqual(chat, legacy, 'mode "chat" must equal the legacy 3-arg call');
    assert.deepEqual(chat, expected, 'chat mode must be byte-for-byte pre-GL-4');
  });

  it('the built-in anthropic DEFAULT_TARGET path is NOT broken (anthropic vars survive chat)', () => {
    isolateOpencode();
    const uid = 811;
    const chat = resolveProviderEnv(uid, 'opencode', dirtyEnv(), 'chat');

    // The built-in `anthropic` opencode provider legitimately reads these from
    // env; GL-4 must never touch them in chat mode.
    assert.equal(chat.ANTHROPIC_BASE_URL, 'https://api.anthropic.com');
    assert.equal(chat.ANTHROPIC_API_KEY, 'sk-ant-operator');
    assert.equal(chat.CLAUDE_CODE_OAUTH_TOKEN, 'oauth-owner-subscription');
    assert.equal(chat.GITHUB_TOKEN, 'ghp_operator');
    assert.equal(chat.SOME_VENDOR_BASE_URL, 'https://intruder.example');
  });
});

describe('GL-4 — seam contracts unchanged for anonymous / shared opencode', () => {
  // The in-seam sanitize is scoped to authenticated, isolated carrier spawns.
  // Anonymous (null userId) and admin-shared opencode keep their pre-existing
  // fail-open contract here; the single launcher seam (SL-3, GL-8) applies the
  // ultimate fail-closed sanitize on those paths.
  it('anonymous (null userId) carrier spawn returns the base env unchanged', () => {
    isolateOpencode();
    const base = dirtyEnv();
    const env = resolveProviderEnv(null, 'opencode', { ...base }, 'agent');
    assert.deepEqual(env, base);
  });

  it('shared-by-policy opencode carrier spawn returns the base env unchanged', () => {
    _resetProviderSharingCache();
    setProviderSharingConfig({ opencode: 'shared' });
    const base = dirtyEnv();
    const env = resolveProviderEnv(812, 'opencode', { ...base }, 'agent');
    assert.deepEqual(env, base);
  });
});
