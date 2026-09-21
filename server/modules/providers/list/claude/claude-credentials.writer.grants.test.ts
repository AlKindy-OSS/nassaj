/**
 * claude-credentials.writer.grants.test — B-1251.
 *
 * A credential WRITE is an act on one's own account, never on the account one
 * merely borrows. With an ACTIVE credential grant from A to B, the resolver
 * (correctly, for a spawn) answers A's tree for B — so the writer must ask it
 * for B's OWN tree instead. Before the fix, B pasting their personal
 * `claude setup-token` landed in A's settings.json, erased A's credential and
 * put A (and A's other grantees) on B's personal subscription.
 *
 * The grant here is the REAL mechanism — `credentialGrantsDb.grant` + the real
 * `resolveProviderEnv` — not a stub around the seam under test; the first
 * assertion pins that the grant is genuinely live before the write is made.
 *
 * Bootstrap mirrors credential-grants.test.ts: sandboxed $HOME + throwaway DB
 * opened before importing any project module. Runner: node:test.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-claude-cred-grants-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const ORIGINAL_SECRETS_KEY = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
const ORIGINAL_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = crypto.randomBytes(32).toString('base64');
delete process.env.CLAUDE_CONFIG_DIR;
assert.equal(os.homedir(), sandboxHome);

const { initializeDatabase, closeConnection, userDb, credentialGrantsDb } =
  await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } =
  await import('@/services/provider-sharing.js');
const { resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js');
const { userConfigDir } = await import('@/services/isolation/provision-user-dirs.js');
const { ClaudeCredentialsWriter } = await import('./claude-credentials.writer.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated' });

const grantor = userDb.createUser('grantor-a', 'hash', 'user');
const grantee = userDb.createUser('grantee-b', 'hash', 'user');

const writer = new ClaudeCredentialsWriter();
const settingsOf = (id: number) => path.join(userConfigDir(id, '.claude'), 'settings.json');

/** Distinct, obviously-personal values so a cross-write is unmistakable. */
const TOKEN_A = 'sk-ant-oat01-GRANTOR-A-PERSONAL';
const TOKEN_B = 'sk-ant-oat01-GRANTEE-B-PERSONAL';

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME; else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  if (ORIGINAL_SECRETS_KEY === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = ORIGINAL_SECRETS_KEY;
  if (ORIGINAL_CONFIG_DIR !== undefined) process.env.CLAUDE_CONFIG_DIR = ORIGINAL_CONFIG_DIR;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('B-1251 — a credential write never follows a grant', () => {
  before(async () => {
    // A links their own subscription first: the file the bug destroyed.
    await writer.setApiKey(grantor.id, TOKEN_A);
    // The real grant mechanism — no stub in front of resolveProviderEnv.
    credentialGrantsDb.grant(grantor.id, grantee.id, 'claude');
  });

  it('the grant is live: a SPAWN for B resolves A tree (the behavior we keep)', () => {
    assert.equal(
      resolveProviderEnv(grantee.id, 'claude', {}).CLAUDE_CONFIG_DIR,
      userConfigDir(grantor.id, '.claude'),
      'precondition — without an active grant this test proves nothing',
    );
  });

  it('B setApiKey writes into B own tree and leaves A file byte-identical', async () => {
    const before = fs.readFileSync(settingsOf(grantor.id));

    const result = await writer.setApiKey(grantee.id, TOKEN_B);
    assert.deepEqual(result, { provider: 'claude', configured: true });

    const granteeEnv = JSON.parse(fs.readFileSync(settingsOf(grantee.id), 'utf8')).env;
    assert.equal(granteeEnv.CLAUDE_CODE_OAUTH_TOKEN, TOKEN_B, 'B token lands in B tree');

    const afterBytes = fs.readFileSync(settingsOf(grantor.id));
    assert.ok(afterBytes.equals(before), 'A settings.json untouched, byte for byte');
    assert.equal(
      JSON.parse(afterBytes.toString('utf8')).env.CLAUDE_CODE_OAUTH_TOKEN,
      TOKEN_A,
      'A keeps their own credential',
    );
  });

  it('status for B reports B own tree, not the grantor credential', async () => {
    assert.equal(await writer.isConfigured(grantee.id), true);
  });

  it('B deleteApiKey removes B credential and never the grantor one', async () => {
    const before = fs.readFileSync(settingsOf(grantor.id));

    await writer.deleteApiKey(grantee.id);

    const granteeSettings = JSON.parse(fs.readFileSync(settingsOf(grantee.id), 'utf8'));
    assert.equal(granteeSettings.env?.CLAUDE_CODE_OAUTH_TOKEN, undefined);
    assert.ok(
      fs.readFileSync(settingsOf(grantor.id)).equals(before),
      'A settings.json untouched by B delete',
    );
    assert.equal(await writer.isConfigured(grantor.id), true, 'A still connected');
  });
});
