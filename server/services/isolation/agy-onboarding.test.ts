/**
 * agy-onboarding.test.ts — per-user agy (antigravity) connection-status check
 * (ADR-023). Verifies getAgyConnectionStatus reports connected=true only when the
 * user's OWN isolated dir holds a valid agy token, and never leaks the token.
 *
 * HOME is sandboxed before importing the module so userConfigDir resolves under
 * tmp, never the operator's real ~/.nassaj-users. Runner: node:test + tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-agy-onboard-test-'));
const ORIGINAL_HOME = process.env.HOME;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { getAgyConnectionStatus } = await import('./agy-onboarding.service.js');
const { userConfigDir } = await import('./provision-user-dirs.js');

/** Creates a user's isolated agy dir and returns the token file path. */
function makeTokenPath(userId: number): string {
  const dir = userConfigDir(userId, path.join('.gemini', 'antigravity-cli'));
  fs.mkdirSync(dir, { recursive: true });
  return path.join(dir, 'antigravity-oauth-token');
}

after(() => {
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('getAgyConnectionStatus', () => {
  it('reports not connected when the user dir does not exist', async () => {
    const status = await getAgyConnectionStatus(2001);
    assert.deepEqual(status, { connected: false, provider: 'agy' });
  });

  it('reports connected for a token with access_token + refresh_token', async () => {
    const tokenPath = makeTokenPath(2002);
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({
        token: { access_token: 'ya29.secret-xyz', refresh_token: '1//r', expiry: '2000-01-01T00:00:00Z' },
        auth_method: 'consumer',
      })
    );
    const status = await getAgyConnectionStatus(2002);
    assert.equal(status.connected, true, 'expired access token + refresh_token is still connected');
    assert.equal(status.provider, 'agy');
    // The token value must never appear in the response.
    assert.equal(JSON.stringify(status).includes('ya29.secret-xyz'), false);
  });

  it('reports connected for an unexpired access_token with no refresh_token', async () => {
    const tokenPath = makeTokenPath(2003);
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({
        token: { access_token: 'ya29.fresh', expiry: '2999-01-01T00:00:00Z' },
      })
    );
    assert.equal((await getAgyConnectionStatus(2003)).connected, true);
  });

  it('reports NOT connected for an expired access_token with no refresh_token', async () => {
    const tokenPath = makeTokenPath(2004);
    fs.writeFileSync(
      tokenPath,
      JSON.stringify({
        token: { access_token: 'ya29.old', expiry: '2000-01-01T00:00:00Z' },
      })
    );
    assert.equal((await getAgyConnectionStatus(2004)).connected, false);
  });

  it('reports not connected for an empty/blank access_token', async () => {
    const tokenPath = makeTokenPath(2005);
    fs.writeFileSync(tokenPath, JSON.stringify({ token: { access_token: '   ' } }));
    assert.equal((await getAgyConnectionStatus(2005)).connected, false);
  });

  it('reports not connected for a malformed token file (no throw)', async () => {
    const tokenPath = makeTokenPath(2006);
    fs.writeFileSync(tokenPath, '{ not valid json');
    assert.equal((await getAgyConnectionStatus(2006)).connected, false);
  });

  it('reports not connected when the token has no token object', async () => {
    const tokenPath = makeTokenPath(2007);
    fs.writeFileSync(tokenPath, JSON.stringify({ auth_method: 'consumer' }));
    assert.equal((await getAgyConnectionStatus(2007)).connected, false);
  });
});
