/**
 * ADR-200 S2 (M-6) — under a credential grant (ADR-152) the pinned spawn's
 * derived config dir is built from the GRANTOR's tree, matching
 * resolveProviderEnv, and still carries none of the grantor's Anthropic keys.
 *
 * The grant is the real mechanism (credentialGrantsDb.grant + the real
 * resolveProviderEnv). Bootstrap mirrors claude-credentials.writer.grants.test:
 * sandboxed $HOME and a throwaway DB opened before any project import.
 */
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-engine-pin-grants-'));
const ORIGINAL = {
  HOME: process.env.HOME,
  DATABASE_PATH: process.env.DATABASE_PATH,
  NASSAJ_PROVIDER_SECRETS_KEY: process.env.NASSAJ_PROVIDER_SECRETS_KEY,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
};
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
const { prepareEnginePinConfigDir } = await import('./engine-pin-config-dir.js');

await initializeDatabase();
_resetProviderSharingCache();
setProviderSharingConfig({ claude: 'isolated' });

const grantor = userDb.createUser('pin-grantor-a', 'hash', 'user');
const grantee = userDb.createUser('pin-grantee-b', 'hash', 'user');
const DUMMY_KEY_A = 'sk' + '-ant-api03-GRANTOR-A-DUMMY';

after(() => {
  closeConnection();
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('ADR-200 S2 — derived dir under a grant', () => {
  let grantorTree = '';

  before(() => {
    // Provision A's tree through the real resolver, then plant A's API key.
    grantorTree = String(resolveProviderEnv(grantor.id, 'claude', {}).CLAUDE_CONFIG_DIR);
    fs.writeFileSync(path.join(grantorTree, 'settings.json'),
      JSON.stringify({ env: { ANTHROPIC_API_KEY: DUMMY_KEY_A } }));
    fs.writeFileSync(path.join(grantorTree, '.claude.json'),
      JSON.stringify({ primaryApiKey: DUMMY_KEY_A, marker: 'grantor-a' }));
    credentialGrantsDb.grant(grantor.id, grantee.id, 'claude');
  });

  it('the grantee spawn resolves the grantor tree (precondition)', () => {
    const env = resolveProviderEnv(grantee.id, 'claude', {});
    assert.equal(env.CLAUDE_CONFIG_DIR, userConfigDir(grantor.id, '.claude'));
  });

  it('the derived dir comes from the grantor tree and holds none of its keys', async () => {
    const env = resolveProviderEnv(grantee.id, 'claude', {});
    const derived = await prepareEnginePinConfigDir(env, { operatorHome: sandboxHome });
    assert.equal(derived, path.join(path.dirname(grantorTree), '.claude-engine-pin'));
    const config = JSON.parse(fs.readFileSync(path.join(derived, '.claude.json'), 'utf8'));
    assert.equal(config.marker, 'grantor-a', 'copied from the grantor tree');
    assert.equal('primaryApiKey' in config, false);
    const settings = JSON.parse(fs.readFileSync(path.join(derived, 'settings.json'), 'utf8'));
    assert.equal(settings.env?.ANTHROPIC_API_KEY, undefined);
    assert.equal(
      fs.realpathSync(path.join(derived, 'projects')),
      fs.realpathSync(path.join(grantorTree, 'projects')),
      'resume continuity follows the grantor tree',
    );
    assert.equal(fs.existsSync(path.join(derived, '.credentials.json')), false);
  });
});
