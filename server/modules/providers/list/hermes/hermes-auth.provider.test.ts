/**
 * Regression: Hermes login and auth-status must inspect the same isolated HOME.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes-auth-home-'));
const operatorHome = path.join(sandbox, 'operator');
const binDir = path.join(sandbox, 'bin');
const userId = 42;
const userHome = path.join(operatorHome, '.nassaj-users', String(userId));

fs.mkdirSync(path.join(operatorHome, '.hermes'), { recursive: true });
fs.mkdirSync(path.join(userHome, '.hermes'), { recursive: true });
fs.mkdirSync(binDir, { recursive: true });

// Make the installation probe hermetic; no real Hermes executable is invoked.
const fakeHermes = path.join(binDir, 'hermes');
fs.writeFileSync(fakeHermes, '#!/bin/sh\nexit 0\n', { mode: 0o755 });

const config = 'model:\n  default: test-model\n  provider: nous\n';
fs.writeFileSync(path.join(operatorHome, '.hermes', 'config.yaml'), config);

// Operator credentials are deliberately invalid. If getStatus ignores userId,
// this is the verdict it will return and the regression test will fail.
fs.writeFileSync(path.join(operatorHome, '.hermes', 'auth.json'), JSON.stringify({
  providers: {
    nous: { last_auth_error: { code: 'invalid_grant', message: 'operator credential is invalid' } },
  },
  credential_pool: { nous: [] },
}));

// The isolated user's credential is valid. The value is a synthetic fixture and
// is never printed or returned by the provider.
fs.writeFileSync(path.join(userHome, '.hermes', 'auth.json'), JSON.stringify({
  providers: { nous: { access_token: 'test-token-not-real' } },
  credential_pool: { nous: [] },
}));

const originalEnv = {
  HOME: process.env.HOME,
  PATH: process.env.PATH,
  DATABASE_PATH: process.env.DATABASE_PATH,
};

process.env.HOME = operatorHome;
process.env.PATH = `${binDir}${path.delimiter}${originalEnv.PATH ?? ''}`;
process.env.DATABASE_PATH = path.join(sandbox, 'auth.db');

// resolveProviderEnv consults the sharing policy through the database. Keep the
// test fully isolated from the application's real database.
const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
initializeDatabase();

const { HermesProviderAuth } = await import('./hermes-auth.provider.js');
const auth = new HermesProviderAuth();

after(() => {
  try { closeConnection(); } catch { /* already closed */ }
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('getStatus(userId) reads auth and runtime config from the isolated Hermes HOME', async () => {
  const status = await auth.getStatus(userId);

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, true);
  assert.equal(status.email, 'nous credentials');
  assert.equal(status.method, 'oauth');
});

test('getStatus(null) retains the operator HOME fallback', async () => {
  const status = await auth.getStatus(null);

  assert.equal(status.installed, true);
  assert.equal(status.authenticated, false);
  assert.match(status.error ?? '', /operator credential is invalid/);
});
