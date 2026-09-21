/**
 * claude-credentials.writer.test.ts — T-866/B3.
 *
 * Proves the Claude API-key writer merges env.ANTHROPIC_API_KEY into
 * settings.json while preserving every other setting, deletes only that key,
 * and — the load-bearing guarantee — enforces the IRON RULE: it can never write
 * a *_BASE_URL (or any other) env key. userId=null + a pinned CLAUDE_CONFIG_DIR
 * keep the suite hermetic (no isolation/DB). Runner: node:test + node:assert.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-cred-writer-'));
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
process.env.CLAUDE_CONFIG_DIR = sandbox;

const { ClaudeCredentialsWriter, assertOnlyManagedEnvKeyChanged } =
  await import('./claude-credentials.writer.js');

const settingsPath = path.join(sandbox, 'settings.json');
const writer = new ClaudeCredentialsWriter();
const KEY = 'sk-ant-secret-DO-NOT-LEAK';

function readSettings(): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
}

beforeEach(() => {
  fs.rmSync(settingsPath, { force: true });
});

after(() => {
  if (ORIGINAL_CONFIG_DIR === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('capability is native_file with no targets (single implicit key)', () => {
  assert.deepEqual(writer.getWriterCapability(), { method: 'native_file' });
});

test('setApiKey merges env.ANTHROPIC_API_KEY, preserving other settings', async () => {
  fs.writeFileSync(settingsPath, JSON.stringify({
    theme: 'dark',
    env: { SOME_OTHER: 'keep-me' },
    permissions: { allow: ['Bash'] },
  }));

  const result = await writer.setApiKey(null, KEY);
  assert.deepEqual(result, { provider: 'claude', configured: true });

  const settings = readSettings();
  assert.equal(settings.theme, 'dark', 'unrelated top-level settings preserved');
  assert.deepEqual(settings.permissions, { allow: ['Bash'] });
  const env = settings.env as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(env.SOME_OTHER, 'keep-me', 'other env entries preserved');
  assert.equal(fs.statSync(settingsPath).mode & 0o777, 0o600);
});

test('setApiKey creates a valid settings.json when none exists', async () => {
  await writer.setApiKey(null, KEY);
  const env = readSettings().env as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal(await writer.isConfigured(null), true);
});

test('deleteApiKey removes only ANTHROPIC_API_KEY, leaving other settings intact', async () => {
  fs.writeFileSync(settingsPath, JSON.stringify({
    theme: 'light',
    env: { ANTHROPIC_API_KEY: KEY, SOME_OTHER: 'keep-me' },
  }));

  const result = await writer.deleteApiKey(null);
  assert.deepEqual(result, { provider: 'claude', configured: false });
  const settings = readSettings();
  assert.equal(settings.theme, 'light');
  const env = settings.env as Record<string, string>;
  assert.equal('ANTHROPIC_API_KEY' in env, false, 'key removed');
  assert.equal(env.SOME_OTHER, 'keep-me', 'other env preserved');
});

test('an explicit target is rejected (claude has a single implicit target)', async () => {
  await assert.rejects(
    () => writer.setApiKey(null, KEY, 'anthropic'),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_CREDENTIAL_TARGET',
  );
});

test('a pre-existing ANTHROPIC_BASE_URL in settings is left untouched by a key write', async () => {
  // The iron-rule tripwire only forbids WRITING a base url; an operator-set one
  // that we do not change must survive a key merge (we never strip it either).
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { ANTHROPIC_BASE_URL: 'https://api.anthropic.com' },
  }));
  await writer.setApiKey(null, KEY);
  const env = readSettings().env as Record<string, string>;
  assert.equal(env.ANTHROPIC_BASE_URL, 'https://api.anthropic.com', 'base url preserved, not stripped');
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
});

test('IRON RULE: assertOnlyManagedEnvKeyChanged blocks *_BASE_URL and foreign keys', () => {
  // The managed key alone is allowed.
  assert.doesNotThrow(() => assertOnlyManagedEnvKeyChanged(['ANTHROPIC_API_KEY']));
  assert.doesNotThrow(() => assertOnlyManagedEnvKeyChanged([]));
  // Any base-url key is refused outright.
  assert.throws(
    () => assertOnlyManagedEnvKeyChanged(['ANTHROPIC_BASE_URL']),
    /IRON RULE/,
  );
  assert.throws(
    () => assertOnlyManagedEnvKeyChanged(['ANTHROPIC_API_KEY', 'OPENAI_BASE_URL']),
    /IRON RULE/,
  );
  // Any other unmanaged key is refused too (defense in depth).
  assert.throws(
    () => assertOnlyManagedEnvKeyChanged(['SOME_OTHER']),
    /unmanaged env key/,
  );
});

const OAUTH_TOKEN = 'sk-ant-oat01-DO-NOT-LEAK';

test('setApiKey routes a setup-token to CLAUDE_CODE_OAUTH_TOKEN, not ANTHROPIC_API_KEY', async () => {
  const result = await writer.setApiKey(null, OAUTH_TOKEN);
  assert.deepEqual(result, { provider: 'claude', configured: true });
  const env = readSettings().env as Record<string, string>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_TOKEN);
  assert.equal('ANTHROPIC_API_KEY' in env, false, 'a setup-token is not an API key');
  assert.equal(await writer.isConfigured(null), true);
});

test('setApiKey keeps the two managed credentials mutually exclusive', async () => {
  await writer.setApiKey(null, KEY);
  let env = readSettings().env as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  // Switching to a setup-token removes the stale API key.
  await writer.setApiKey(null, OAUTH_TOKEN);
  env = readSettings().env as Record<string, string>;
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, OAUTH_TOKEN);
  assert.equal('ANTHROPIC_API_KEY' in env, false, 'stale API key removed');
  // Switching back removes the stale OAuth token.
  await writer.setApiKey(null, KEY);
  env = readSettings().env as Record<string, string>;
  assert.equal(env.ANTHROPIC_API_KEY, KEY);
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false, 'stale OAuth token removed');
});

test('deleteApiKey removes both managed credential keys, leaving others intact', async () => {
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN, SOME_OTHER: 'keep-me' },
  }));
  const result = await writer.deleteApiKey(null);
  assert.deepEqual(result, { provider: 'claude', configured: false });
  const env = readSettings().env as Record<string, string>;
  assert.equal('CLAUDE_CODE_OAUTH_TOKEN' in env, false, 'OAuth token removed');
  assert.equal(env.SOME_OTHER, 'keep-me', 'other env preserved');
  assert.equal(await writer.isConfigured(null), false);
});

test('isConfigured is true for a CLAUDE_CODE_OAUTH_TOKEN alone', async () => {
  fs.writeFileSync(settingsPath, JSON.stringify({
    env: { CLAUDE_CODE_OAUTH_TOKEN: OAUTH_TOKEN },
  }));
  assert.equal(await writer.isConfigured(null), true);
});

test('IRON RULE: the tripwire allows CLAUDE_CODE_OAUTH_TOKEN but still refuses base urls', () => {
  assert.doesNotThrow(() => assertOnlyManagedEnvKeyChanged(['CLAUDE_CODE_OAUTH_TOKEN']));
  assert.doesNotThrow(() => assertOnlyManagedEnvKeyChanged(['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN']));
  assert.throws(
    () => assertOnlyManagedEnvKeyChanged(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_BASE_URL']),
    /IRON RULE/,
  );
});
