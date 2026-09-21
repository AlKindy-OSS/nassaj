/**
 * provision-permissions.test.ts — B-MU-OS-PERM / ADR-023 Decision 2.
 *
 * Verifies provisionUserDirs hardens the isolated tree: user root and config
 * subdirs to 0700, and a present credential file to 0600 — independent of the
 * process umask (the explicit chmod pass must enforce it even if mkdir's mode
 * was masked). Symlinked credentials are NOT chmod-ed (would rewrite the shared
 * operator file's mode).
 *
 * HOME + DATABASE_PATH are sandboxed before importing any project module so the
 * DB singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-perm-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });
process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

await initializeDatabase();

// Seed users so provisionUserDirs' audit insert satisfies its FK.
const TEST_IDS = [5001, 5002] as const;
{
  const db = getConnection();
  const stmt = db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash) VALUES (?, ?, 'x')"
  );
  for (const id of TEST_IDS) stmt.run(id, `perm-user-${id}`);
}

/** Lower 9 permission bits of a path, e.g. 0o700. */
function mode(p: string): number {
  return fs.statSync(p).mode & 0o777;
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('provisionUserDirs permission hardening', () => {
  it('sets the user root and config subdirs to 0700 even under a loose umask', () => {
    const prevUmask = process.umask(0o000); // force loose umask so mkdir would be 0777
    try {
      const userId = 5001;
      provisionUserDirs(userId);
      const root = userConfigDir(userId, '');

      assert.equal(mode(root), 0o700, 'user root must be 0700');
      for (const sub of ['.claude', '.gemini', '.codex']) {
        assert.equal(mode(path.join(root, sub)), 0o700, `${sub} must be 0700`);
      }
    } finally {
      process.umask(prevUmask);
    }
  });

  it('tightens a pre-existing real .credentials.json to 0600 on provisioning', () => {
    // A fresh id whose .claude dir + a world-readable real credential file exist
    // BEFORE the (first, non-short-circuited) provisioning pass. The hardening
    // pass must tighten it to 0600. (Symlinked credentials are skipped — covered
    // by chmodIfPresent's isSymlink guard — so we use a real file here.)
    const userId = 5002;
    const claudeDir = userConfigDir(userId, '.claude');
    fs.mkdirSync(claudeDir, { recursive: true });
    const credPath = path.join(claudeDir, '.credentials.json');
    fs.writeFileSync(credPath, '{"claudeAiOauth":{"accessToken":"x"}}', { mode: 0o644 });
    fs.chmodSync(credPath, 0o644); // ensure 0644 regardless of umask

    provisionUserDirs(userId);

    assert.equal(mode(credPath), 0o600, '.credentials.json must be 0600 after provisioning');
  });
});
