/**
 * isolation.e2e.test.ts — per-user credential isolation seam (ADR-014/016).
 *
 * Verifies the three layers that, together, guarantee a user never spawns a
 * provider CLI with another user's credentials:
 *
 *   1. resolveProviderEnv  — builds the child-process env and is the SOLE place
 *      a per-user CONFIG_DIR/HOME override is applied. We assert it (a) leaves
 *      the env untouched for anonymous/system spawns, (b) sets the right knob
 *      per provider for every authenticated user, and (c) cannot be turned back
 *      to the operator env by any stored policy (ADR-152 A1: isolation is a
 *      constant; the install-wide sharing policy is retired).
 *   2. provisionUserDirs   — creates the isolated tree + shared symlinks. We
 *      point os.homedir() at a tmp HOME and assert the .claude/.gemini/.codex
 *      dirs and the shared projects/ symlink are created.
 *
 * Test isolation:
 *   - A throwaway SQLite file (DATABASE_PATH) is created BEFORE importing any
 *     module so the shared connection singleton opens the tmp DB, never the
 *     real project DB at ~/.local/share/nassaj-dev/db.sqlite.
 *   - HOME is redirected to a tmp dir so provisionUserDirs/userConfigDir write
 *     only under tmp. (os.homedir() honors $HOME on this platform.)
 *
 * Runner: Node built-in test runner (node:test + node:assert). No Jest/Vitest.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';

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
const { resolveProviderEnv } = await import('./resolve-provider-env.js');
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

// Apply the full schema once so audit_log records
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
// Isolation is a constant: no policy is set or read. A non-process baseEnv is
// passed so assertions never mutate the real env.
// ===========================================================================
describe('resolveProviderEnv isolation logic', () => {
  it('refuses a null, empty or undefined actor for every provider (ADR-152 A1 §3.4)', () => {
    // No anonymous path to the operator environment exists any more.
    const base: NodeJS.ProcessEnv = { PATH: '/usr/bin', EXISTING: '1' };
    for (const provider of ['claude', 'codex', 'agy', 'cursor'] as const) {
      for (const actor of [null, '', undefined]) {
        assert.throws(
          () => resolveProviderEnv(actor as unknown as null, provider, { ...base }),
          { code: 'CREDENTIAL_ACTOR_REQUIRED' },
          `${provider}/${String(actor)}`,
        );
      }
    }
  });

  it('sets CLAUDE_CONFIG_DIR to the per-user path when claude is isolated', () => {
    const env = resolveProviderEnv(42, 'claude', { PATH: '/usr/bin' });

    const expected = userConfigDir(42, '.claude');
    assert.equal(env.CLAUDE_CONFIG_DIR, expected);
    assert.ok(
      expected.startsWith(path.join(sandboxHome, '.nassaj-users', '42')),
      'per-user claude dir must live under the user root'
    );
    // Other providers' knobs must NOT be set on a claude spawn.
    assert.equal(env.CODEX_HOME, undefined);
  });

  it('never hands a member the operator CLAUDE_CONFIG_DIR (no shared mode, ADR-152 A1)', () => {
    const base = { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/operator/.claude' };
    const env = resolveProviderEnv(42, 'claude', { ...base });

    assert.equal(env.CLAUDE_CONFIG_DIR, userConfigDir(42, '.claude'));
    assert.notEqual(env.CLAUDE_CONFIG_DIR, '/operator/.claude');
  });

  it('sets CODEX_HOME to the per-user path when isolated', () => {

    const cEnv = resolveProviderEnv(42, 'codex', { PATH: '/usr/bin' });
    assert.equal(cEnv.CODEX_HOME, userConfigDir(42, '.codex'));
  });

  it('rewrites HOME to the per-user root when agy is isolated', () => {
    // agy has no dedicated knob: isolation works by pointing HOME at the
    // per-user root so its brain store resolves into the isolated tree.
    const env = resolveProviderEnv(42, 'agy', { PATH: '/usr/bin', HOME: '/operator/home' });

    assert.equal(env.HOME, userConfigDir(42, ''));
    assert.notEqual(env.HOME, '/operator/home', 'isolated agy must override HOME');
  });

  it('never hands a member the operator HOME for agy or cursor (no shared mode, ADR-152 A1)', () => {
    for (const provider of ['agy', 'cursor'] as const) {
      const env = resolveProviderEnv(42, provider, { PATH: '/usr/bin', HOME: '/operator/home' });
      assert.equal(env.HOME, userConfigDir(42, ''), provider);
    }
  });
});

// ===========================================================================
// 2) provisionUserDirs — filesystem provisioning under the sandboxed HOME
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

  it('creates the isolated first-party CLI trees, including .qwen', () => {
    // Use a fresh userId per assertion run so the in-process "provisioned"
    // guard inside provisionUserDirs never short-circuits this case.
    const userId = 9001;
    const root = userConfigDir(userId, '');

    provisionUserDirs(userId);

    for (const sub of ['.claude', '.gemini', '.codex', '.qwen']) {
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
