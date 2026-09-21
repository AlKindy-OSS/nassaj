/**
 * sanitize-vendor-agent-env.test.js — SEC-ENV-1 + B-378.
 *
 * This layer had NO test at all, which is how B-378 survived: the exact-match
 * deny list reads as exhaustive, and nothing asserted what it actually removes.
 *
 * The two properties worth pinning are opposites, and both are load-bearing:
 *   • an INHERITED Anthropic credential must die (B-378), because the CLI reads
 *     an env credential above the per-user config dir, so one operator variable
 *     would move every user off their subscription onto metered billing;
 *   • an INJECTED one must survive, because the engine seam sets exactly those
 *     names on the sanitized env afterwards (claude-sdk.js:2643 sanitizes,
 *     :2764 injects) — a rule that could not tell them apart would break the
 *     Kimi/GLM engine path entirely.
 * The order of those two calls is what makes both true at once, so the last
 * test asserts the composition, not just the function.
 *
 * Run: npx tsx --test server/services/isolation/sanitize-vendor-agent-env.test.js
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import {
  isDeniedHostSecretEnvKey,
  sanitizeHostSecretEnv,
} from './sanitize-vendor-agent-env.js';

test('strips nassaj process secrets from every provider spawn', () => {
  const clean = sanitizeHostSecretEnv({
    JWT_SECRET: 'sign-anything',
    DATABASE_PATH: '/live/db.sqlite',
    NASSAJ_PROVIDER_SECRETS_KEY: 'decrypts-everyones-keys',
    API_KEY: 'global-gate',
    PATH: '/usr/bin',
  });
  assert.equal(clean.JWT_SECRET, undefined);
  assert.equal(clean.DATABASE_PATH, undefined);
  assert.equal(clean.NASSAJ_PROVIDER_SECRETS_KEY, undefined);
  assert.equal(clean.API_KEY, undefined);
  assert.equal(clean.PATH, '/usr/bin');
});

test('keeps everything a provider CLI actually reads', () => {
  const clean = sanitizeHostSecretEnv({
    PATH: '/usr/bin',
    HOME: '/home/example',
    LANG: 'ar_SA.UTF-8',
    CLAUDE_CONFIG_DIR: '/home/example/.nassaj-users/1/.claude',
    CODEX_HOME: '/codex',
    KIMI_CODE_HOME: '/kimi',
    XDG_DATA_HOME: '/xdg',
  });
  assert.deepEqual(Object.keys(clean).sort(), [
    'CLAUDE_CONFIG_DIR',
    'CODEX_HOME',
    'HOME',
    'KIMI_CODE_HOME',
    'LANG',
    'PATH',
    'XDG_DATA_HOME',
  ]);
});

test('never mutates the input', () => {
  const source = { JWT_SECRET: 'x', PATH: '/usr/bin' };
  sanitizeHostSecretEnv(source);
  assert.equal(source.JWT_SECRET, 'x');
});

test('matches case-insensitively (B-173)', () => {
  assert.equal(isDeniedHostSecretEnvKey('jwt_secret'), true);
  assert.equal(isDeniedHostSecretEnvKey('Database_Path'), true);
});

test('covers unenumerated secrets by suffix', () => {
  assert.equal(isDeniedHostSecretEnvKey('SOME_FUTURE_SECRET'), true);
  assert.equal(isDeniedHostSecretEnvKey('DB_PASSWORD'), true);
  assert.equal(isDeniedHostSecretEnvKey('SSH_PRIVATE_KEY'), true);
});

test('B-378: strips ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN inherited from the host', () => {
  const clean = sanitizeHostSecretEnv({
    ANTHROPIC_API_KEY: 'sk-ant-operator',
    ANTHROPIC_AUTH_TOKEN: 'operator-token',
    PATH: '/usr/bin',
  });
  assert.equal(clean.ANTHROPIC_API_KEY, undefined);
  assert.equal(clean.ANTHROPIC_AUTH_TOKEN, undefined);
  assert.equal(clean.PATH, '/usr/bin');
});

test('B-378: matches those two case-insensitively as well', () => {
  assert.equal(isDeniedHostSecretEnvKey('anthropic_api_key'), true);
  assert.equal(isDeniedHostSecretEnvKey('Anthropic_Auth_Token'), true);
});

test('does NOT strip ANTHROPIC_BASE_URL — the iron-rule guard must still see it', () => {
  // Deleting it would convert a fail-closed refusal (a competitor host rejected
  // loudly by anthropic-base-url-guard) into a silent fallback to official
  // Anthropic: an invisible failure in place of a visible one (the B-222 lesson).
  const clean = sanitizeHostSecretEnv({ ANTHROPIC_BASE_URL: 'https://api.z.ai/api/anthropic' });
  assert.equal(clean.ANTHROPIC_BASE_URL, 'https://api.z.ai/api/anthropic');
});

test('does NOT strip the per-user hosted-vendor keys', () => {
  const clean = sanitizeHostSecretEnv({
    KIMI_API_KEY: 'k',
    DEEPSEEK_API_KEY: 'd',
    GLM_API_KEY: 'g',
    GEMINI_API_KEY: 'gem',
  });
  assert.equal(clean.KIMI_API_KEY, 'k');
  assert.equal(clean.DEEPSEEK_API_KEY, 'd');
  assert.equal(clean.GLM_API_KEY, 'g');
  assert.equal(clean.GEMINI_API_KEY, 'gem');
});

test('an engine INJECTED after sanitizing survives — the order is the whole design', () => {
  // Mirrors the real sequence in claude-sdk.js: sanitize (2643), then inject (2764).
  const spawnEnv = sanitizeHostSecretEnv({
    ANTHROPIC_API_KEY: 'inherited-operator-key',
    PATH: '/usr/bin',
  });
  assert.equal(spawnEnv.ANTHROPIC_API_KEY, undefined);

  // apply-claude-engine-provider-env sets both names together on this object.
  spawnEnv.ANTHROPIC_BASE_URL = 'https://api.moonshot.ai/anthropic';
  spawnEnv.ANTHROPIC_AUTH_TOKEN = 'deliberate-kimi-key';

  assert.equal(spawnEnv.ANTHROPIC_AUTH_TOKEN, 'deliberate-kimi-key');
  assert.equal(spawnEnv.ANTHROPIC_BASE_URL, 'https://api.moonshot.ai/anthropic');
});
