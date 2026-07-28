/**
 * isolation.e2e.test.ts — per-user credential isolation seam (ADR-014/016).
 *
 * Verifies the three layers that, together, guarantee a user never spawns a
 * provider CLI with another user's credentials:
 *
 *   1. resolveProviderEnv  — builds the child-process env and is the SOLE place
 *      a per-user CONFIG_DIR/HOME override is applied. We assert it (a) leaves
 *      the env untouched for anonymous/system spawns, (b) sets the right knob
 *      per provider when that provider is isolated, and (c) leaves the env
 *      untouched when the admin marks a provider 'shared'.
 *   2. provider-sharing    — the admin policy that decides which providers are
 *      isolated. We exercise the real DB round-trip: defaults, a write, the
 *      hot-path isProviderIsolated check, and a reload after a cache reset.
 *   3. provisionUserDirs   — creates the isolated tree + shared symlinks. We
 *      point os.homedir() at a tmp HOME and assert the .claude/.gemini/.codex
 *      dirs and the shared projects/ symlink are created.
 *
 * Test isolation:
 *   - A throwaway SQLite file (DATABASE_PATH) is created BEFORE importing any
 *     module so the shared connection singleton opens the tmp DB, never the
 *     real project DB at ~/.local/share/nassaj-dev/db.sqlite.
 *   - HOME is redirected to a tmp dir so provisionUserDirs/userConfigDir write
 *     only under tmp. (os.homedir() honors $HOME on this platform.)
 *   - isProviderIsolated is driven through the real DB policy via
 *     setProviderSharingConfig + _resetProviderSharingCache rather than a
 *     module mock (node:test module mocking is gated behind an experimental
 *     flag and not enabled here): controlling the policy controls exactly what
 *     resolveProviderEnv's isolation gate sees.
 *
 * Runner: Node built-in test runner (node:test + node:assert). No Jest/Vitest.
 */

import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';

import fs from 'fs';
import os from 'os';
import path from 'path';

// ---------------------------------------------------------------------------
// Test environment bootstrap — MUST run before any project module is imported,
// because the DB connection singleton resolves DATABASE_PATH on first use and
// provisionUserDirs/userConfigDir read os.homedir() (which honors $HOME here).
// ---------------------------------------------------------------------------

const TMP_PREFIX = path.join(os.tmpdir(), 'nassaj-isolation-test-');
const sandbox = fs.mkdtempSync(TMP_PREFIX);

// Sandbox HOME so provisionUserDirs never touches the operator's real
// ~/.nassaj-users tree. Save the original to restore in teardown.
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;

// Throwaway DB file; created/opened lazily by the connection singleton.
const tmpDbPath = path.join(sandbox, 'test-db.sqlite');
process.env.DATABASE_PATH = tmpDbPath;

// Sanity: the override actually redirects os.homedir(); if a future platform
// stops honoring $HOME this assertion fails loudly instead of silently writing
// into the operator's real home.
assert.equal(
  os.homedir(),
  sandboxHome,
  'os.homedir() must honor the sandboxed $HOME; provisionUserDirs would otherwise write to the real home'
);

// Now safe to import the modules under test (they pick up the tmp DB + HOME).
const { initializeDatabase, closeConnection, getConnection } = await import('@/modules/database/index.js');
const {
  getProviderSharingConfig,
  setProviderSharingConfig,
  isProviderIsolated,
  _resetProviderSharingCache,
} = await import('../provider-sharing.js');
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

// Apply the full schema once so provider-sharing writes and audit_log records
// (emitted by provisionUserDirs through resolveProviderEnv) land in real tables.
await initializeDatabase();

// Seed the user ids the filesystem cases provision for. provisionUserDirs
// records a 'user_dirs_provisioned' audit row whose user_id is a FK to
// users(id); without a matching user the (swallowed) insert fails the FK and
// spams the log. Seeding makes the audit write a real, successful insert.
const TEST_USER_IDS = [42, 9001, 9002, 9003, 9004] as const;
{
  const db = getConnection();
  const insertUser = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')"
  );
  for (const id of TEST_USER_IDS) insertUser.run(id, `test-user-${id}`);
}

after(() => {
  // Close the SQLite handle, then restore the process environment and remove
  // the sandbox so the suite leaves no trace and never touches real state.
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

// ===========================================================================
// 1) resolveProviderEnv — isolation logic
//
// The isolation gate inside resolveProviderEnv calls isProviderIsolated, which
// reads the DB-backed policy. We set that policy explicitly per case (reset
// cache first) so "isolated"/"shared" is deterministic and independent of any
// previously stored value — the equivalent of mocking isProviderIsolated.
// A non-process baseEnv is passed so assertions never mutate the real env.
// ===========================================================================
describe('resolveProviderEnv isolation logic', () => {
  /** Force a specific policy for the providers a case cares about. */
  function setPolicy(patch: Record<string, 'shared' | 'isolated'>) {
    _resetProviderSharingCache();
    setProviderSharingConfig({
      claude: 'isolated',
      gemini: 'isolated',
      codex: 'isolated',
      agy: 'shared',
      cursor: 'shared',
      ...patch,
    });
  }

  it('returns base env unchanged for every provider when userId is null', () => {
    // Anonymous/system/platform-mode spawn: no isolation regardless of policy.
    setPolicy({ claude: 'isolated', agy: 'isolated' });
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', EXISTING: '1' };

    for (const provider of ['claude', 'gemini', 'codex', 'agy', 'cursor'] as const) {
      const env = resolveProviderEnv(null, provider, { ...base });
      assert.deepEqual(env, base, `${provider}: anonymous env must be unchanged`);
      assert.equal(env.CLAUDE_CONFIG_DIR, undefined);
      assert.equal(env.GEMINI_CLI_HOME, undefined);
      assert.equal(env.CODEX_HOME, undefined);
      // HOME must not be rewritten for an anonymous agy spawn.
      assert.equal(env.HOME, undefined);
    }
  });

  it('also treats empty-string and undefined userId as anonymous (no isolation)', () => {
    setPolicy({ claude: 'isolated' });
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin' };
    assert.deepEqual(resolveProviderEnv('', 'claude', { ...base }), base);
    assert.deepEqual(
      resolveProviderEnv(undefined as unknown as null, 'claude', { ...base }),
      base
    );
  });

  it('sets CLAUDE_CONFIG_DIR to the per-user path when claude is isolated', () => {
    setPolicy({ claude: 'isolated' });
    const env = resolveProviderEnv(42, 'claude', { PATH: '/usr/bin' });

    const expected = userConfigDir(42, '.claude');
    assert.equal(env.CLAUDE_CONFIG_DIR, expected);
    assert.ok(
      expected.startsWith(path.join(sandboxHome, '.nassaj-users', '42')),
      'per-user claude dir must live under the user root'
    );
    // Other providers' knobs must NOT be set on a claude spawn.
    assert.equal(env.GEMINI_CLI_HOME, undefined);
    assert.equal(env.CODEX_HOME, undefined);
  });

  it('leaves env unchanged when claude is marked shared (admin policy)', () => {
    // Same user, but the admin shared claude → operator credentials, env intact.
    setPolicy({ claude: 'shared' });
    const base = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/operator/.claude' };
    const env = resolveProviderEnv(42, 'claude', { ...base });

    assert.deepEqual(env, base, 'shared claude must not apply a per-user override');
    assert.equal(env.CLAUDE_CONFIG_DIR, '/operator/.claude');
  });

  it('sets GEMINI_CLI_HOME / CODEX_HOME to per-user paths when isolated', () => {
    setPolicy({ gemini: 'isolated', codex: 'isolated' });

    const gEnv = resolveProviderEnv(42, 'gemini', { PATH: '/usr/bin' });
    assert.equal(gEnv.GEMINI_CLI_HOME, userConfigDir(42, ''));

    const cEnv = resolveProviderEnv(42, 'codex', { PATH: '/usr/bin' });
    assert.equal(cEnv.CODEX_HOME, userConfigDir(42, '.codex'));
  });

  it('rewrites HOME to the per-user root when agy is isolated', () => {
    // agy has no dedicated knob: isolation works by pointing HOME at the
    // per-user root so its brain store resolves into the isolated tree.
    setPolicy({ agy: 'isolated' });
    const env = resolveProviderEnv(42, 'agy', { PATH: '/usr/bin', HOME: '/operator/home' });

    assert.equal(env.HOME, userConfigDir(42, ''));
    assert.notEqual(env.HOME, '/operator/home', 'isolated agy must override HOME');
  });

  it('leaves env (and HOME) unchanged when agy is shared (default policy)', () => {
    setPolicy({ agy: 'shared' });
    const base = { PATH: '/usr/bin', HOME: '/operator/home' };
    const env = resolveProviderEnv(42, 'agy', { ...base });

    assert.deepEqual(env, base, 'shared agy must not rewrite HOME');
    assert.equal(env.HOME, '/operator/home');
  });
});

// ===========================================================================
// 2) provider-sharing — config round-trip against the real (tmp) DB
// ===========================================================================
describe('provider-sharing config round-trip', () => {
  beforeEach(() => {
    // Each case starts from the persisted default so order never matters.
    _resetProviderSharingCache();
    setProviderSharingConfig({
      claude: 'isolated',
      gemini: 'isolated',
      codex: 'isolated',
      agy: 'shared',
      cursor: 'shared',
    });
  });

  it('returns the documented default policy after a fresh default write', () => {
    assert.deepEqual(getProviderSharingConfig(), {
      claude: 'isolated',
      gemini: 'isolated',
      codex: 'isolated',
      agy: 'shared',
      cursor: 'shared',
      // opencode defaults to 'shared' (OC-07): inherits the operator XDG tree so
      // an install with no stored config is byte-for-byte unchanged.
      opencode: 'shared',
      // Hosted vendor providers default to isolated: their key is per-user in the
      // encrypted secrets store, never a shared operator key (B-VR-2B).
      kimi: 'isolated',
      deepseek: 'isolated',
      glm: 'isolated',
    });
  });

  it('persists a partial patch and keeps the other providers intact', () => {
    const stored = setProviderSharingConfig({ claude: 'shared' } as Record<string, 'shared'>);

    // setProviderSharingConfig normalizes a partial input: unspecified
    // providers fall back to the documented default, not to the prior value.
    assert.equal(stored.claude, 'shared');
    assert.equal(getProviderSharingConfig().claude, 'shared');
    assert.equal(getProviderSharingConfig().gemini, 'isolated');
  });

  it('reflects the write through the isProviderIsolated hot path', () => {
    setProviderSharingConfig({ claude: 'shared' } as Record<string, 'shared'>);

    assert.equal(isProviderIsolated('claude'), false, 'claude was just marked shared');
    assert.equal(isProviderIsolated('gemini'), true, 'gemini is unchanged → still isolated');
    // An unknown provider is treated as not isolated (shared) by contract.
    assert.equal(isProviderIsolated('totally-unknown'), false);
  });

  it('reloads the same policy from the DB after the cache is dropped', () => {
    setProviderSharingConfig({ claude: 'shared', codex: 'shared' } as Record<string, 'shared'>);
    const beforeReset = getProviderSharingConfig();

    // Drop the in-process cache so the next read re-parses from app_config.
    _resetProviderSharingCache();
    const afterReset = getProviderSharingConfig();

    assert.deepEqual(afterReset, beforeReset, 'reload must reproduce the persisted policy');
    assert.equal(afterReset.claude, 'shared');
    assert.equal(afterReset.codex, 'shared');
    assert.equal(afterReset.gemini, 'isolated');
  });
});

// ===========================================================================
// 3) provisionUserDirs — filesystem provisioning under the sandboxed HOME
// ===========================================================================
describe('provisionUserDirs filesystem layout', () => {
  /** True if `p` is a symlink (even a dangling one). */
  function isLinkAt(p: string): boolean {
    try {
      return fs.lstatSync(p).isSymbolicLink();
    } catch {
      return false;
    }
  }

  it('creates the isolated .claude/.gemini/.codex tree for a new user', () => {
    // Use a fresh userId per assertion run so the in-process "provisioned"
    // guard inside provisionUserDirs never short-circuits this case.
    const userId = 9001;
    const root = userConfigDir(userId, '');

    provisionUserDirs(userId);

    for (const sub of ['.claude', '.gemini', '.codex']) {
      const dir = path.join(root, sub);
      assert.ok(fs.existsSync(dir), `${sub} should be created`);
      assert.ok(fs.statSync(dir).isDirectory(), `${sub} should be a directory`);
    }
  });

  it('symlinks the per-user claude projects/ back to the shared root', () => {
    // Pre-create the shared ~/.claude/projects so the optional symlink is made
    // (ensureSymlink skips a missing target — shared resources are optional).
    const sharedProjects = path.join(sandboxHome, '.claude', 'projects');
    fs.mkdirSync(sharedProjects, { recursive: true });

    const userId = 9002;
    provisionUserDirs(userId);

    const link = path.join(userConfigDir(userId, '.claude'), 'projects');
    assert.ok(fs.existsSync(link), 'projects symlink should exist');
    const stat = fs.lstatSync(link);
    assert.ok(stat.isSymbolicLink(), 'projects must be a symlink, not a real dir');
    assert.equal(
      fs.realpathSync(link),
      fs.realpathSync(sharedProjects),
      'projects symlink must point at the shared root'
    );
  });

  it('skips agents/skills/plugins symlinks when the operator has no such dirs', () => {
    // Runs BEFORE the case below creates ~/.claude/agents|skills|plugins in
    // the sandbox: ensureSymlink must no-op on a missing target, leaving the
    // user's .claude/ without dangling links. (node:test runs cases in order.)
    assert.ok(!fs.existsSync(path.join(sandboxHome, '.claude', 'agents')));
    assert.ok(!fs.existsSync(path.join(sandboxHome, '.claude', 'skills')));
    assert.ok(!fs.existsSync(path.join(sandboxHome, '.claude', 'plugins')));

    const userId = 9003;
    provisionUserDirs(userId);

    const claudeDir = userConfigDir(userId, '.claude');
    for (const name of ['agents', 'skills', 'plugins']) {
      const link = path.join(claudeDir, name);
      assert.ok(!fs.existsSync(link), `${name} link must not be created`);
      assert.ok(!isLinkAt(link), `${name} must not exist even as a dangling symlink`);
    }
  });

  it('symlinks shared agents/, skills/ and plugins/ for ALL users when the operator dirs exist', () => {
    // ADR-023 Decision 3: agent cards, skills and plugins are fully shared.
    // Pre-create the operator dirs, then assert a (non-owner) user's .claude/
    // links back.
    const sharedAgents = path.join(sandboxHome, '.claude', 'agents');
    const sharedSkills = path.join(sandboxHome, '.claude', 'skills');
    const sharedPlugins = path.join(sandboxHome, '.claude', 'plugins');
    fs.mkdirSync(sharedAgents, { recursive: true });
    fs.mkdirSync(sharedSkills, { recursive: true });
    fs.mkdirSync(sharedPlugins, { recursive: true });
    fs.writeFileSync(path.join(sharedAgents, 'ui-designer.md'), '# ui-designer');

    const userId = 9004;
    provisionUserDirs(userId);

    const claudeDir = userConfigDir(userId, '.claude');
    for (const [name, shared] of [
      ['agents', sharedAgents],
      ['skills', sharedSkills],
      ['plugins', sharedPlugins],
    ] as const) {
      const link = path.join(claudeDir, name);
      assert.ok(fs.existsSync(link), `${name} symlink should exist`);
      assert.ok(fs.lstatSync(link).isSymbolicLink(), `${name} must be a symlink, not a real dir`);
      assert.equal(
        fs.realpathSync(link),
        fs.realpathSync(shared),
        `${name} symlink must point at the operator's shared dir`
      );
    }

    // An agent card placed by the operator is visible through the user's link.
    assert.ok(
      fs.existsSync(path.join(claudeDir, 'agents', 'ui-designer.md')),
      'operator agent cards must be visible through the per-user link'
    );

    // settings.json must stay per-user (intentionally NOT symlinked).
    assert.ok(
      !isLinkAt(path.join(claudeDir, 'settings.json')),
      'settings.json must not be symlinked to the operator file'
    );
  });

  it('is a no-op for null/empty userId (no stray dirs created)', () => {
    const before = fs.readdirSync(path.join(sandboxHome, '.nassaj-users'));
    provisionUserDirs(null as unknown as number);
    provisionUserDirs('' as unknown as number);
    const after = fs.readdirSync(path.join(sandboxHome, '.nassaj-users'));
    assert.deepEqual(after, before, 'anonymous provisioning must not create user dirs');
  });
});
