/**
 * claude-auth.provider.test.ts — B-190 regression.
 *
 * Locks the install/auth SPLIT that stops a misleading credentials WARN:
 *
 *   - `isInstalled()` is the install-only probe. It reports CLI presence and must
 *     NEVER read, resolve, or LOG credential state — so a bare "is claude here?"
 *     check (the spawn error handler in claude-sdk.js, via
 *     providerAuthService.isProviderInstalled) can no longer emit the
 *     "[claude-auth] credentials check failed ... configDir=~/.claude" line about
 *     an expired OPERATOR token while an isolated user's real spawn env is fine.
 *   - `getStatus()` (the /auth/status path) MUST still log that diagnostic for an
 *     expired token, so the fix silences the install probe WITHOUT blinding the
 *     genuine per-user credential report.
 *
 * Hermetic: a sandboxed $HOME + throwaway DB (mirrors resolve-provider-env.test.ts,
 * needed because getStatus() pulls the resolveProviderEnv import chain), a pinned
 * CLAUDE_CONFIG_DIR holding an EXPIRED credentials file, and CLAUDE_CLI_PATH aimed
 * at the node binary so the CLI version probe succeeds without a real claude.
 * Runner: node:test + node:assert/strict (no vitest).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-auth-b190-'));
const sandboxHome = path.join(sandbox, 'home');
const configDir = path.join(sandbox, 'config');
fs.mkdirSync(sandboxHome, { recursive: true });
fs.mkdirSync(configDir, { recursive: true });

// An EXPIRED oauth credentials file (fixture token — not a real secret; the code
// under test never logs token values, only booleans).
fs.writeFileSync(
  path.join(configDir, '.credentials.json'),
  JSON.stringify({
    claudeAiOauth: {
      accessToken: 'test-access-token-not-real',
      expiresAt: Date.now() - 60_000,
    },
  }),
);

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
// So checkCredentials falls through to the credentials FILE (not an env token).
delete process.env.ANTHROPIC_AUTH_TOKEN;
delete process.env.ANTHROPIC_API_KEY;
delete process.env.CLAUDE_CODE_OAUTH_TOKEN;

// Initialize a throwaway DB before importing the provider: its static import
// chain (resolveProviderEnv -> provider-sharing -> database) must never touch the
// real app DB.
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();

const { ClaudeProviderAuth } = await import('./claude-auth.provider.js');
const auth = new ClaudeProviderAuth();

const CRED_WARN = '[claude-auth] credentials check failed';

/** Runs `fn` with console.warn captured; returns the collected warn lines. */
async function captureWarns(fn: () => unknown | Promise<unknown>): Promise<{ result: unknown; warns: string[] }> {
  const warns: string[] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => { warns.push(args.map(String).join(' ')); };
  try {
    const result = await fn();
    return { result, warns };
  } finally {
    console.warn = original;
  }
}

after(() => {
  try { closeConnection(); } catch { /* already closed */ }
  for (const [k, v] of Object.entries(ORIGINAL)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('isInstalled() is true when the CLI runs and emits NO credential warning (expired creds present)', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath; // `node --version` exits 0
  const { result, warns } = await captureWarns(() => auth.isInstalled());
  assert.equal(result, true, 'CLI probe should report installed');
  assert.equal(
    warns.some((w) => w.includes(CRED_WARN)),
    false,
    'install-only probe must not log a credentials-check failure',
  );
});

test('isInstalled() is false for a missing CLI and still emits no credential warning', async () => {
  process.env.CLAUDE_CLI_PATH = path.join(sandbox, 'no-such-claude-binary');
  const { result, warns } = await captureWarns(() => auth.isInstalled());
  assert.equal(result, false, 'a missing binary should report not-installed');
  assert.equal(
    warns.some((w) => w.includes(CRED_WARN)),
    false,
    'a not-installed result must not depend on (or log) credential state',
  );
});

test('getStatus() STILL logs the credential diagnostic for an expired token (diagnostic preserved)', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  const { result, warns } = await captureWarns(() => auth.getStatus());
  const status = result as { authenticated: boolean; installed: boolean };
  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false, 'an expired token must report unauthenticated');
  const line = warns.find((w) => w.includes(CRED_WARN));
  assert.ok(line, 'the real status path must still surface the credential failure');
  assert.match(line!, /credentials-file-expired/, 'reason should identify the expiry');
});
