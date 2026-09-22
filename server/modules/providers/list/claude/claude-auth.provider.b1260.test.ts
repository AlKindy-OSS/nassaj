/**
 * claude-auth.provider.b1260.test.ts — B-1260 status honesty.
 *
 * The badge must stop calling a PARTIAL Claude credential "fully linked":
 *   - a `.credentials.json` with an access token but NO refresh token cannot be
 *     renewed (the exact false-"linked" shape reported on a fleet node) → incomplete;
 *   - credentials whose stored scopes omit the profile scope (inference-only) →
 *     incomplete;
 *   - an inference-only `CLAUDE_CODE_OAUTH_TOKEN` (a `setup-token`) still runs a
 *     turn (authenticated) but is flagged incomplete, not a complete link;
 *   - a full access + refresh + profile credential stays fully linked;
 *   - an empty/absent credential is NOT reported as a (false) success.
 *
 * Hermetic: sandboxed $HOME + throwaway DB + a pinned CLAUDE_CONFIG_DIR the test
 * rewrites per case. CLAUDE_CLI_PATH points at node so the CLI version probe
 * exits 0 without a real claude. Runner: node:test + node:assert/strict.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-b1260-'));
const sandboxHome = path.join(sandbox, 'home');
const configDir = path.join(sandbox, 'config');
fs.mkdirSync(sandboxHome, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

const ORIGINAL = {
  HOME: process.env.HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  CLAUDE_CLI_PATH: process.env.CLAUDE_CLI_PATH,
  ANTHROPIC_AUTH_TOKEN: process.env.ANTHROPIC_AUTH_TOKEN,
  ANTHROPIC_API_KEY: process.env.ANTHROPIC_API_KEY,
  CLAUDE_CODE_OAUTH_TOKEN: process.env.CLAUDE_CODE_OAUTH_TOKEN,
};

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.CLAUDE_CONFIG_DIR = configDir;
process.env.CLAUDE_CLI_PATH = process.execPath; // `node --version` exits 0
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();

const { ClaudeProviderAuth } = await import('./claude-auth.provider.js');
const auth = new ClaudeProviderAuth();

const CRED_PATH = path.join(configDir, '.credentials.json');
const SETTINGS_PATH = path.join(configDir, 'settings.json');

/** Silences the (expected) credential-failure WARN so the run stays quiet. */
async function quietly<T>(fn: () => Promise<T>): Promise<T> {
  const original = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = original;
  }
}

function writeCreds(oauth: Record<string, unknown>): void {
  fs.writeFileSync(CRED_PATH, JSON.stringify({ claudeAiOauth: oauth }));
}

beforeEach(() => {
  // A clean slate per case: no leftover credential/settings file.
  fs.rmSync(CRED_PATH, { force: true });
  fs.rmSync(SETTINGS_PATH, { force: true });
});

after(() => {
  try { closeConnection(); } catch { /* already closed */ }
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('B-1260: access token with NO refresh token → incomplete link, not linked', async () => {
  // The reported fleet-node shape: accessToken + scopes, no refreshToken, no expiresAt.
  writeCreds({
    accessToken: 'sk-fixture',
    scopes: ['file_upload', 'inference', 'mcp_servers', 'profile', 'sessions:claude_code'],
    subscriptionType: 'max',
  });
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, false);
  assert.equal(status.incompleteLink, true);
  assert.match(status.error ?? '', /incomplete/i);
});

test('B-1260: inference-only scopes (no profile) → incomplete link', async () => {
  writeCreds({
    accessToken: 'sk-fixture',
    refreshToken: 'rt-fixture',
    expiresAt: Date.now() + 3_600_000,
    scopes: ['inference'],
  });
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, false);
  assert.equal(status.incompleteLink, true);
});

test('B-1260: full access + refresh + profile → fully linked (not incomplete)', async () => {
  writeCreds({
    accessToken: 'sk-fixture',
    refreshToken: 'rt-fixture',
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 13 * 86_400_000,
    scopes: ['profile', 'inference'],
  });
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, true);
  assert.equal(status.incompleteLink, false);
  assert.equal(status.method, 'credentials_file');
});

test('B-1260: the REAL measured full-OAuth scope array + refresh → fully linked', async () => {
  // qa-critic live measurement (two fleet nodes): every working full-OAuth
  // credential carries exactly these scopes plus a refresh token.
  writeCreds({
    accessToken: 'sk-fixture',
    refreshToken: 'rt-fixture',
    expiresAt: Date.now() + 3_600_000,
    refreshTokenExpiresAt: Date.now() + 13 * 86_400_000,
    scopes: [
      'user:file_upload',
      'user:inference',
      'user:mcp_servers',
      'user:plugins',
      'user:profile',
      'user:sessions:claude_code',
    ],
  });
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, true);
  assert.equal(status.incompleteLink, false);
  assert.equal(status.method, 'credentials_file');
});

test('B-1260: settings.json setup-token is authenticated but flagged incomplete', async () => {
  fs.writeFileSync(
    SETTINGS_PATH,
    JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fixture' } }),
  );
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, true);
  assert.equal(status.incompleteLink, true);
  assert.equal(status.method, 'oauth_token');
});

test('B-1260: empty/absent credential is NOT reported as success', async () => {
  // No .credentials.json, no settings.json, no env token → honest "not linked".
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, false);
  assert.notEqual(status.incompleteLink, true);
});

test('B-1260: a credential with a blank access token is not a success', async () => {
  writeCreds({ accessToken: '   ', refreshToken: 'rt-fixture' });
  const status = await quietly(() => auth.getStatus());
  assert.equal(status.authenticated, false);
});
