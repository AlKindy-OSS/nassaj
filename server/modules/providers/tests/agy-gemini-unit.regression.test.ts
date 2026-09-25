/**
 * T-1853 — agy regression guard for the Gemini CLI provider deletion.
 *
 * The string 'gemini' outlived the deleted provider on purpose: it is agy's
 * on-disk CREDENTIAL UNIT (`~/.gemini`), its governance file (`GEMINI.md`), its
 * MCP home (`.gemini/config/mcp_config.json`) and the Google model family agy
 * serves. A past removal deleted these by grep and silently broke agy, so every
 * load-bearing use is pinned here: a wrong deletion fails this file.
 *
 * HOME + DATABASE_PATH are sandboxed before importing any project module so the
 * DB singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-agy-gemini-unit-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Operator tree as a real install has it: agy state + the neutral GEMINI.md.
const OPERATOR_GEMINI = path.join(sandboxHome, '.gemini');
fs.mkdirSync(path.join(OPERATOR_GEMINI, 'antigravity-cli', 'brain'), { recursive: true });
fs.writeFileSync(path.join(OPERATOR_GEMINI, 'GEMINI.md'), '# neutral agy governance (test)\n');

const { initializeDatabase, closeConnection, getConnection } = await import('@/modules/database/index.js');
const { setProviderSharingConfig, _resetProviderSharingCache } = await import('@/services/provider-sharing.js');
const { credentialUnit, GRANTABLE_UNITS } = await import('@/services/isolation/credential-principal.js');
const { GRANT_HOME_PROVIDERS, materializeGrantHome } = await import('@/services/isolation/grant-home.js');
const { resolveProviderEnv } = await import('@/services/isolation/resolve-provider-env.js');
const { provisionUserDirs, userConfigDir, invalidateProvisioned } = await import('@/services/isolation/provision-user-dirs.js');
const { isDeniedVendorAgentEnvKey, sanitizeVendorAgentEnv } = await import('@/services/isolation/sanitize-vendor-agent-env.js');
const { providerGovernanceService } = await import('@/modules/providers/services/provider-governance.service.js');
const { providerMcpService } = await import('@/modules/providers/services/mcp.service.js');
const { ANTIGRAVITY_FALLBACK_MODELS } = await import(
  '@/modules/providers/list/antigravity/antigravity-models.provider.js'
);
const { AntigravityMcpProvider } = await import('@/modules/providers/list/antigravity/antigravity-mcp.provider.js');

await initializeDatabase();

const OWNER_ID = 8101;
const MEMBER_ID = 8102;
{
  const db = getConnection();
  const insert = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', ?)",
  );
  insert.run(OWNER_ID, 'agy-unit-owner', 'owner');
  insert.run(MEMBER_ID, 'agy-unit-member', 'user');
}

_resetProviderSharingCache();
setProviderSharingConfig({ agy: 'isolated' });

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const BASE: NodeJS.ProcessEnv = Object.freeze({ PATH: '/usr/bin:/bin', HOME: '/operator/home' });

describe('agy credential unit is still named gemini', () => {
  it('credentialUnit folds agy into the gemini unit and the unit stays grantable', () => {
    assert.equal(credentialUnit('agy'), 'gemini');
    assert.ok(GRANTABLE_UNITS.includes('gemini'), 'gemini must remain a grantable unit');
    assert.ok(!GRANTABLE_UNITS.includes('agy'), 'agy is never its own unit');
  });

  it('a grant home for agy links the owner .gemini tree', () => {
    assert.ok(GRANT_HOME_PROVIDERS.includes('agy'));
    const ownerGemini = userConfigDir(OWNER_ID, '.gemini');
    fs.mkdirSync(ownerGemini, { recursive: true });
    const home = materializeGrantHome(MEMBER_ID, OWNER_ID, ['agy']);
    const link = path.join(home, '.gemini');
    assert.ok(fs.lstatSync(link).isSymbolicLink(), '.gemini must be a link into the owner tree');
    assert.equal(fs.realpathSync(link), fs.realpathSync(ownerGemini));
  });

  it('resolveProviderEnv gives an isolated agy a per-user HOME', () => {
    const agyEnv = resolveProviderEnv(MEMBER_ID, 'agy', { ...BASE });
    assert.equal(agyEnv.HOME, userConfigDir(MEMBER_ID, ''));
    assert.equal(agyEnv.GEMINI_CLI_HOME, undefined, 'HOME is the only knob agy reads');
  });

  it('the deleted provider id is no longer an isolation policy key', () => {
    assert.throws(
      () => resolveProviderEnv(MEMBER_ID, 'gemini', { ...BASE }),
      (error: unknown) => (error as { code?: string }).code === 'PROVIDER_ISOLATION_UNAVAILABLE',
    );
  });
});

describe('agy home provisioning and governance', () => {
  it('provisionUserDirs creates .gemini/antigravity-cli with the shared brain and a 0444 GEMINI.md', () => {
    invalidateProvisioned(MEMBER_ID);
    provisionUserDirs(MEMBER_ID);
    const userGemini = userConfigDir(MEMBER_ID, '.gemini');
    const brain = path.join(userGemini, 'antigravity-cli', 'brain');
    assert.ok(fs.lstatSync(brain).isSymbolicLink(), 'the agy brain is shared through a link');
    assert.equal(fs.realpathSync(brain), fs.realpathSync(path.join(OPERATOR_GEMINI, 'antigravity-cli', 'brain')));
    const geminiMd = path.join(userGemini, 'GEMINI.md');
    const stat = fs.lstatSync(geminiMd);
    assert.ok(stat.isFile() && !stat.isSymbolicLink(), 'GEMINI.md is a real copy, not a link');
    assert.equal(stat.mode & 0o777, 0o444);
  });

  it('the agy governance channel is gemini-md and reads governed after provisioning', () => {
    const descriptor = providerGovernanceService.getGovernance('antigravity', MEMBER_ID);
    assert.equal(descriptor.mechanism, 'gemini-md');
    assert.equal(descriptor.status, 'governed');
  });
});

describe('agy MCP, legacy cleanup, env and models', () => {
  it('agy reads and writes MCP servers in .gemini/config/mcp_config.json', () => {
    const provider = new AntigravityMcpProvider() as unknown as {
      scopedConfigPath(scope: string, workspacePath: string, userId?: number): string;
    };
    assert.equal(
      provider.scopedConfigPath('user', '', MEMBER_ID),
      path.join(userConfigDir(MEMBER_ID, ''), '.gemini', 'config', 'mcp_config.json'),
    );
  });

  it('the legacy cleaner still removes a connector entry from .gemini/settings.json', async () => {
    const name = 'nassaj-connector-legacy';
    const settings = path.join(userConfigDir(MEMBER_ID, ''), '.gemini', 'settings.json');
    fs.mkdirSync(path.dirname(settings), { recursive: true });
    fs.writeFileSync(settings, JSON.stringify({ mcpServers: { [name]: { command: 'legacy' } }, theme: 'x' }));

    const results = await providerMcpService.removeMcpServerFromAllProviders({ name, scope: 'user', userId: MEMBER_ID });

    const legacy = results.find((result) => result.provider === 'gemini');
    assert.equal(legacy?.state, 'removed');
    assert.equal(legacy?.verified, true);
    const after = JSON.parse(fs.readFileSync(settings, 'utf8')) as { mcpServers?: Record<string, unknown>; theme?: string };
    assert.equal(after.mcpServers?.[name], undefined);
    assert.equal(after.theme, 'x', 'unrelated settings survive the cleanup');
  });

  it('the vendor-agent sanitizer still strips every GEMINI_* variable', () => {
    assert.equal(isDeniedVendorAgentEnvKey('GEMINI_CLI_HOME'), true);
    const clean = sanitizeVendorAgentEnv({ PATH: '/usr/bin', GEMINI_SOMETHING: 'x' });
    assert.equal(clean.GEMINI_SOMETHING, undefined);
    assert.equal(clean.PATH, '/usr/bin');
  });

  it('the agy fallback catalog still offers the gemini-* model family', () => {
    const values = ANTIGRAVITY_FALLBACK_MODELS.OPTIONS.map((option) => option.value);
    assert.ok(values.some((value) => value.startsWith('gemini-')), 'agy serves Google gemini-* models');
  });
});
