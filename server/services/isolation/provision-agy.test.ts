/**
 * provision-agy.test.ts — agy (antigravity) per-user isolation (ADR-023).
 *
 * Mirrors the claude isolation contract for agy:
 *   - brain is SHARED for every user (owner + non-owner): a symlink to the
 *     operator's single ~/.gemini/antigravity-cli/brain, mirroring .claude/projects.
 *   - the agy OAuth token is OWNER-ONLY symlinked from the operator dir; a
 *     non-owner gets no token (must run `agy` to authenticate).
 *   - a non-owner's REAL token file is hardened to 0600.
 *
 * HOME + DATABASE_PATH are sandboxed before importing any project module so the
 * DB singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-agy-prov-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Seed the operator agy dir with a token, installation_id, settings.json and a
// brain store, exactly as a real install has them.
const OPERATOR_AGY = path.join(sandboxHome, '.gemini', 'antigravity-cli');
fs.mkdirSync(path.join(OPERATOR_AGY, 'brain', 'uuid-shared-1'), { recursive: true });
fs.writeFileSync(
  path.join(OPERATOR_AGY, 'antigravity-oauth-token'),
  JSON.stringify({ token: { access_token: 'op-secret', refresh_token: 'r' } })
);
fs.writeFileSync(path.join(OPERATOR_AGY, 'installation_id'), 'install-xyz');
fs.writeFileSync(path.join(OPERATOR_AGY, 'settings.json'), JSON.stringify({ theme: 'dark' }));

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

await initializeDatabase();

// Seed an owner and a regular user.
const OWNER_ID = 7001;
const USER_ID = 7002;
{
  const db = getConnection();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'owner')"
  ).run(OWNER_ID, 'agy-owner');
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
  ).run(USER_ID, 'agy-user');
}

/** Lower 9 permission bits of a path, e.g. 0o600. */
function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

/** Path to a user's isolated agy dir. */
function agyDir(userId: number): string {
  return userConfigDir(userId, path.join('.gemini', 'antigravity-cli'));
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('provisionUserDirs — agy isolation', () => {
  it('symlinks the SHARED brain for the owner pointing at the operator brain', () => {
    provisionUserDirs(OWNER_ID);
    const brainLink = path.join(agyDir(OWNER_ID), 'brain');
    assert.equal(fs.lstatSync(brainLink).isSymbolicLink(), true, 'brain must be a symlink');
    assert.equal(
      fs.realpathSync(brainLink),
      fs.realpathSync(path.join(OPERATOR_AGY, 'brain')),
      'owner brain must resolve to the operator brain (shared)'
    );
    // The shared conversation is visible through the link.
    assert.equal(
      fs.existsSync(path.join(brainLink, 'uuid-shared-1')),
      true,
      'shared conversation must be visible through the owner brain link'
    );
  });

  it('symlinks the SAME SHARED brain for a non-owner user', () => {
    provisionUserDirs(USER_ID);
    const brainLink = path.join(agyDir(USER_ID), 'brain');
    assert.equal(fs.lstatSync(brainLink).isSymbolicLink(), true, 'brain must be a symlink');
    assert.equal(
      fs.realpathSync(brainLink),
      fs.realpathSync(path.join(OPERATOR_AGY, 'brain')),
      'non-owner brain must resolve to the SAME operator brain (shared for all)'
    );
  });

  it('symlinks the operator token + installation_id + settings.json ONLY for the owner', () => {
    const ownerToken = path.join(agyDir(OWNER_ID), 'antigravity-oauth-token');
    assert.equal(fs.lstatSync(ownerToken).isSymbolicLink(), true, 'owner token must be a symlink');
    assert.equal(
      fs.readFileSync(ownerToken, 'utf8').includes('op-secret'),
      true,
      'owner token must resolve to the operator token'
    );
    for (const name of ['installation_id', 'settings.json']) {
      const link = path.join(agyDir(OWNER_ID), name);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${name} must be symlinked for owner`);
    }
  });

  it('gives a non-owner NO token (they must authenticate their own agy)', () => {
    const userToken = path.join(agyDir(USER_ID), 'antigravity-oauth-token');
    assert.equal(fs.existsSync(userToken), false, 'non-owner must have no agy token');
    assert.equal(
      fs.existsSync(path.join(agyDir(USER_ID), 'installation_id')),
      false,
      'non-owner must not get installation_id'
    );
  });

  it('hardens a non-owner REAL agy token to 0600 on its first provisioning pass', () => {
    // A fresh non-owner whose isolated agy dir + a world-readable REAL token exist
    // BEFORE the (first, non-short-circuited) provisioning pass — the hardening
    // pass must tighten it to 0600. (The in-process guard skips later passes, so
    // the token must pre-exist the FIRST call to exercise hardenUserTree.)
    const PRELOADED = 7004;
    const db = getConnection();
    db.prepare(
      "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
    ).run(PRELOADED, 'agy-preloaded');

    const dir = agyDir(PRELOADED);
    fs.mkdirSync(dir, { recursive: true });
    const userToken = path.join(dir, 'antigravity-oauth-token');
    fs.writeFileSync(userToken, '{"token":{"access_token":"mine"}}', { mode: 0o644 });
    fs.chmodSync(userToken, 0o644);

    provisionUserDirs(PRELOADED);

    assert.equal(mode(userToken), 0o600, 'non-owner real agy token must be 0600 after provisioning');
    assert.equal(
      fs.lstatSync(userToken).isSymbolicLink(),
      false,
      'a non-owner token must be a real file, never the owner symlink'
    );
  });

  it('keeps the agy dir at 0700 even under a loose umask', () => {
    const prevUmask = process.umask(0o000);
    try {
      const FRESH = 7003;
      const db = getConnection();
      db.prepare(
        "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
      ).run(FRESH, 'agy-loose');
      provisionUserDirs(FRESH);
      assert.equal(mode(agyDir(FRESH)), 0o700, 'agy dir must be 0700 under loose umask');
    } finally {
      process.umask(prevUmask);
    }
  });
});
