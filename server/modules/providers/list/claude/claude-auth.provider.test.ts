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
  // The fixture has no refreshToken, so an expired access token really IS a dead
  // link — B-586 renamed the reason to say WHICH clock ran out.
  assert.match(line!, /access-expired-no-refresh/, 'reason should identify the expiry');
});

/* ------------------------------------------------------------------ *
 * B-586 — the badge judged the WRONG clock.
 *
 * `.credentials.json` carries two: `expiresAt` (access token, ~8h, silently
 * rotated by the CLI) and `refreshTokenExpiresAt` (absolute, ~30d, the moment
 * the link actually breaks and `claude /login` becomes mandatory). The old
 * check read the first, so it called a member with two weeks left "expired"
 * and a member with hours left "connected".
 * ------------------------------------------------------------------ */

const DAY = 86_400_000;

/** Rewrites the pinned credentials file for one case. Fixture tokens, not secrets. */
function writeCreds(oauth: Record<string, unknown>): void {
  fs.writeFileSync(
    path.join(configDir, '.credentials.json'),
    JSON.stringify({ claudeAiOauth: { accessToken: 'test-access-token-not-real', ...oauth } }),
  );
}

type Status = { authenticated: boolean; linkExpiry?: { expiresAt: string; daysLeft: number } | null };

test('B-586: expired ACCESS token with a live refresh token stays connected', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  writeCreds({
    expiresAt: Date.now() - 60_000,
    refreshToken: 'test-refresh-token-not-real',
    refreshTokenExpiresAt: Date.now() + 13 * DAY,
  });
  const { result } = await captureWarns(() => auth.getStatus());
  const status = result as Status;
  assert.equal(status.authenticated, true, 'the CLI renews this silently — it is not expired');
  assert.equal(status.linkExpiry?.daysLeft, 13, 'the date is reported far out too, not only when close');
});

test('B-586: inside the 3-day window the link expiry surfaces, rounded up like the CLI', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  const linkExpiresAt = Date.now() + Math.round(1.2 * DAY);
  writeCreds({
    expiresAt: Date.now() + 8 * 3_600_000,
    refreshToken: 'test-refresh-token-not-real',
    refreshTokenExpiresAt: linkExpiresAt,
  });
  const { result } = await captureWarns(() => auth.getStatus());
  const status = result as Status;
  assert.equal(status.authenticated, true, 'still usable until the moment it is not');
  assert.equal(status.linkExpiry?.daysLeft, 2, '1.2 days must ceil to 2, matching the CLI banner');
  assert.equal(status.linkExpiry?.expiresAt, new Date(linkExpiresAt).toISOString());
});

test('B-586: a past link stamp does NOT disconnect while the access token still works', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  // The CLI treats this stamp as a notice, not a gate — its only comparison
  // against the clock lives in the warning banner. Disconnecting here would
  // strip the member of model selection while their terminal keeps working.
  writeCreds({
    expiresAt: Date.now() + 8 * 3_600_000,
    refreshToken: 'test-refresh-token-not-real',
    refreshTokenExpiresAt: Date.now() - 60_000,
  });
  const { result } = await captureWarns(() => auth.getStatus());
  const status = result as Status;
  assert.equal(status.authenticated, true, 'the access token has hours left: still usable');
  assert.equal(status.linkExpiry?.daysLeft, 0, 'warn at zero rather than break without notice');
});

test('B-586: both clocks run out and the credential is finally dead', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  writeCreds({
    expiresAt: Date.now() - 60_000,
    refreshToken: 'test-refresh-token-not-real',
    refreshTokenExpiresAt: Date.now() - 60_000,
  });
  const { result, warns } = await captureWarns(() => auth.getStatus());
  assert.equal((result as Status).authenticated, false, 'no path left: /login is required');
  assert.match(warns.find((w) => w.includes(CRED_WARN))!, /link-expired/);
});

test('B-586: the date keeps being reported on both sides of the warning window', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  const base = {
    expiresAt: Date.now() + 8 * 3_600_000,
    refreshToken: 'test-refresh-token-not-real',
  };

  // The server reports the moment; the client turns daysLeft into a tone. A
  // successful re-login must SHOW its new date, not make the line disappear.
  writeCreds({ ...base, refreshTokenExpiresAt: Date.now() + 3 * DAY - 60_000 });
  const inside = (await captureWarns(() => auth.getStatus())).result as Status;
  assert.equal(inside.linkExpiry?.daysLeft, 3, 'just inside three days');

  writeCreds({ ...base, refreshTokenExpiresAt: Date.now() + 30 * DAY });
  const fresh = (await captureWarns(() => auth.getStatus())).result as Status;
  assert.equal(fresh.linkExpiry?.daysLeft, 30, 'a freshly renewed link reports its full term');
});

test('B-586: a blank refresh token counts as no refresh token', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  writeCreds({ expiresAt: Date.now() - 60_000, refreshToken: '   ' });
  const { result } = await captureWarns(() => auth.getStatus());
  assert.equal((result as Status).authenticated, false, 'whitespace cannot renew anything');
});

test('B-586: a zero expiresAt with no refresh token reads as dead, not as "never expires"', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  // The old `!expiresAt` guard treated the epoch stamp as "no expiry set" and
  // reported a dead credential as connected. Fail closed instead.
  writeCreds({ expiresAt: 0 });
  const { result } = await captureWarns(() => auth.getStatus());
  assert.equal((result as Status).authenticated, false);
});

test('B-586: a credentials file at odds with itself warns about nothing', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  // An access token outliving the link by more than the window means the two
  // stamps disagree; silence beats a warning built on a contradiction.
  writeCreds({
    expiresAt: Date.now() + 10 * DAY,
    refreshToken: 'test-refresh-token-not-real',
    refreshTokenExpiresAt: Date.now() + DAY,
  });
  const { result } = await captureWarns(() => auth.getStatus());
  const status = result as Status;
  assert.equal(status.authenticated, true);
  assert.equal(status.linkExpiry, null, 'contradictory stamps must not produce a countdown');
});

test('B-586: an older credential without refreshTokenExpiresAt is left alone', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  writeCreds({ expiresAt: Date.now() - 60_000, refreshToken: 'test-refresh-token-not-real' });
  const { result } = await captureWarns(() => auth.getStatus());
  const status = result as Status;
  assert.equal(status.authenticated, true, 'absence of the field is not evidence of death');
  assert.equal(status.linkExpiry, null);
});

test('B-586: a key-authenticated path never carries a link expiry', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  // A credential file that WOULD warn if it were consulted — so a leak shows up
  // as a wrong answer, not as an empty one. A stored key has no subscription
  // sign-in to expire; telling its owner "your sign-in expires" is nonsense.
  writeCreds({
    expiresAt: Date.now() + 8 * 3_600_000,
    refreshToken: 'test-refresh-token-not-real',
    refreshTokenExpiresAt: Date.now() + DAY,
  });

  // The key is declared in the member's own settings.json, NOT in the server
  // env: resolveProviderEnv drops ANTHROPIC_* on the way through (measured), so
  // the operator's key can never leak into a member's turn — which also makes
  // settings.json the only route a key actually reaches this check by.
  const settingsPath = path.join(configDir, 'settings.json');
  for (const key of ['ANTHROPIC_AUTH_TOKEN', 'CLAUDE_CODE_OAUTH_TOKEN']) {
    fs.writeFileSync(settingsPath, JSON.stringify({ env: { [key]: 'test-key-not-real' } }));
    const { result } = await captureWarns(() => auth.getStatus());

    const status = result as Status & { method: string | null };
    assert.equal(status.authenticated, true, `${key} should authenticate`);
    assert.notEqual(status.method, 'credentials_file', `${key} must win over the file`);
    assert.equal(status.linkExpiry, null, `${key}: a stored key has no sign-in to expire`);
  }
  fs.rmSync(settingsPath, { force: true });
});

test('B-586: an out-of-range stamp still names the real reason', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  // `-1e308` is valid JSON but outside the Date range: formatting it used to
  // throw inside the try, and the catch relabelled a perfectly readable file as
  // "unreadable" — sending the operator after file permissions instead.
  writeCreds({ expiresAt: -1e308, refreshToken: '' });
  const { result, warns } = await captureWarns(() => auth.getStatus());

  assert.equal((result as Status).authenticated, false, 'an epoch-negative stamp is expired');
  const line = warns.find((w) => w.includes(CRED_WARN));
  assert.ok(line, 'the diagnostic must survive a malformed stamp');
  assert.match(line!, /access-expired-no-refresh/, 'the reason must name the clock that ran out');
  assert.doesNotMatch(line!, /unreadable/, 'a readable file must never be reported unreadable');
});

test('B-586: non-numeric stamps read as absent rather than crashing', async () => {
  process.env.CLAUDE_CLI_PATH = process.execPath;
  writeCreds({
    expiresAt: 'sometime',
    refreshTokenExpiresAt: null,
    refreshToken: 'test-refresh-token-not-real',
  });
  const { result } = await captureWarns(() => auth.getStatus());
  const status = result as Status;

  assert.equal(status.authenticated, true, 'a junk stamp must not kill a live refresh token');
  assert.equal(status.linkExpiry, null, 'nothing known means nothing shown');
});
