/**
 * claude-onboarding.test.ts — per-user Claude connection-status check
 * (B-MU-ONBOARD). Verifies getClaudeConnectionStatus reports connected=true
 * only when the user's OWN isolated dir holds a valid credential artifact, and
 * never leaks the token value.
 *
 * HOME is sandboxed before importing the module so userConfigDir resolves under
 * tmp, never the operator's real ~/.nassaj-users. (os.homedir() honors $HOME.)
 *
 * Runner: Node built-in test runner (node:test + node:assert) via tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-onboarding-test-'));
const ORIGINAL_HOME = process.env.HOME;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;

assert.equal(
  os.homedir(),
  sandboxHome,
  'os.homedir() must honor the sandboxed $HOME so the check reads tmp, not real home'
);

const { getClaudeConnectionStatus } = await import('./claude-onboarding.service.js');
const { userConfigDir } = await import('./provision-user-dirs.js');

/** Creates a user's .claude dir and returns its path. */
function makeClaudeDir(userId: number): string {
  const dir = userConfigDir(userId, '.claude');
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('getClaudeConnectionStatus', () => {
  it('reports not connected when the user dir does not exist', async () => {
    const status = await getClaudeConnectionStatus(1001);
    assert.deepEqual(status, { connected: false, provider: 'claude' });
  });

  it('reports not connected for an empty .claude dir', async () => {
    makeClaudeDir(1002);
    const status = await getClaudeConnectionStatus(1002);
    assert.equal(status.connected, false);
    assert.equal(status.provider, 'claude');
  });

  it('reports connected for a non-expired OAuth credentials.json', async () => {
    const dir = makeClaudeDir(1003);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-secret-xyz', expiresAt: Date.now() + 3_600_000 },
      })
    );
    const status = await getClaudeConnectionStatus(1003);
    assert.equal(status.connected, true);
    // The token value must never appear in the response.
    assert.equal(JSON.stringify(status).includes('sk-secret-xyz'), false);
  });

  it('reports not connected for an expired OAuth token', async () => {
    const dir = makeClaudeDir(1004);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({
        claudeAiOauth: { accessToken: 'sk-old', expiresAt: Date.now() - 1000 },
      })
    );
    assert.equal((await getClaudeConnectionStatus(1004)).connected, false);
  });

  it('reports connected when settings.json declares an Anthropic API key', async () => {
    const dir = makeClaudeDir(1005);
    fs.writeFileSync(
      path.join(dir, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: 'sk-ant-123' } })
    );
    assert.equal((await getClaudeConnectionStatus(1005)).connected, true);
  });

  it('reports not connected when settings.json env is empty', async () => {
    const dir = makeClaudeDir(1006);
    fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ env: {} }));
    assert.equal((await getClaudeConnectionStatus(1006)).connected, false);
  });

  it('reports not connected for a malformed credentials.json (no throw)', async () => {
    const dir = makeClaudeDir(1007);
    fs.writeFileSync(path.join(dir, '.credentials.json'), '{ not valid json');
    assert.equal((await getClaudeConnectionStatus(1007)).connected, false);
  });

  it('ignores a blank accessToken', async () => {
    const dir = makeClaudeDir(1008);
    fs.writeFileSync(
      path.join(dir, '.credentials.json'),
      JSON.stringify({ claudeAiOauth: { accessToken: '   ' } })
    );
    assert.equal((await getClaudeConnectionStatus(1008)).connected, false);
  });
});
