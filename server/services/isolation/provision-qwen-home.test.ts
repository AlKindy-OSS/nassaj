/**
 * provision-qwen-home.test.ts — the Qwen block of provisionUserDirs (ADR-101,
 * ADR-105's account/setup split).
 *
 * Proves:
 *  - a dedicated per-user ~/.qwen is created owner-only (0700).
 *  - collective memory and skills are LINKED back to the operator's tree — the
 *    owner's 2026-08-13 decision that Qwen's memory is shared, not per-user, on
 *    the same model as .claude/projects and the agy brain.
 *  - nassaj's rules arrive as a real read-only (0444) AGENTS.md COPY whose
 *    fingerprint matches the neutral source — a COPY, never a symlink, because a
 *    full-access turn must not write through to the shared fleet source.
 *  - the operator's settings.json is linked for NOBODY and a legacy link is
 *    reaped: that file carries the operator's key in its `env` block, so a link
 *    would put one person's subscription in every member's hands.
 *
 * HOME + DATABASE_PATH are sandboxed before importing any project module so the
 * DB singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-qwen-home-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });

// Seed the neutral governance source from the REAL operator output when present,
// else a representative neutral stub — mirrors provision-kimi-home.test.ts.
let neutralContent: string;
try {
  neutralContent = fs.readFileSync(path.join(String(ORIGINAL_HOME), '.claude', 'AGENTS.md'), 'utf8');
} catch {
  neutralContent =
    '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج (تعليمات مشتركة)\nملف محايد.\n';
}

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');
assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Reproduce the governance topology: ~/.claude -> the governance repo's AGENTS.md.
const NASSAJ_CORE = path.join(sandboxHome, 'governance-repo');
fs.mkdirSync(NASSAJ_CORE, { recursive: true });
fs.writeFileSync(path.join(NASSAJ_CORE, 'AGENTS.md'), neutralContent);
fs.symlinkSync(NASSAJ_CORE, path.join(sandboxHome, '.claude'));

// The operator's own Qwen tree: the knowledge that is shared, and the settings
// file that must NOT be — it holds the operator's subscription key.
const OPERATOR_QWEN = path.join(sandboxHome, '.qwen');
fs.mkdirSync(path.join(OPERATOR_QWEN, 'memories'), { recursive: true });
fs.mkdirSync(path.join(OPERATOR_QWEN, 'skills'), { recursive: true });
fs.writeFileSync(path.join(OPERATOR_QWEN, 'memories', 'MEMORY.md'), '- shared across every body\n');
const OPERATOR_SETTINGS = JSON.stringify({
  $version: 4,
  env: { BAILIAN_TOKEN_PLAN_API_KEY: 'sk-sp-operator-subscription-key' },
});
fs.writeFileSync(path.join(OPERATOR_QWEN, 'settings.json'), OPERATOR_SETTINGS);

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');
const NEUTRAL_FP = sha256(neutralContent);

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir, invalidateProvisioned } = await import(
  './provision-user-dirs.js'
);
const { QWEN_HOME_SUBDIR, QWEN_SETTINGS_FILENAME } = await import('./qwen-settings-material.js');

await initializeDatabase();

const OWNER_ID = 8201;
const USER_ID = 8202;
{
  const db = getConnection();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'owner')",
  ).run(OWNER_ID, 'qwen-owner');
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')",
  ).run(USER_ID, 'qwen-user');
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const qwenHome = (id: number): string => userConfigDir(id, QWEN_HOME_SUBDIR);

describe('provisionUserDirs — Qwen home block (ADR-101)', () => {
  it('creates .qwen owner-only (0700) for a member', () => {
    provisionUserDirs(USER_ID);
    const home = qwenHome(USER_ID);
    assert.equal(fs.statSync(home).isDirectory(), true, '.qwen exists');
    assert.equal(fs.statSync(home).mode & 0o777, 0o700, '.qwen is owner-only 0700');
  });

  it('links collective memory and skills back to the operator tree', () => {
    const home = qwenHome(USER_ID);
    for (const entry of ['memories', 'skills']) {
      const link = path.join(home, entry);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${entry}/ is a symlink`);
      assert.equal(fs.readlinkSync(link), path.join(OPERATOR_QWEN, entry));
    }
    // The share is real, not nominal: what the operator knows, the member reads.
    assert.equal(
      fs.readFileSync(path.join(home, 'memories', 'MEMORY.md'), 'utf8'),
      '- shared across every body\n',
    );
  });

  it('materializes AGENTS.md as a real read-only (0444) COPY matching the neutral source', () => {
    const gov = path.join(qwenHome(USER_ID), 'AGENTS.md');
    const st = fs.lstatSync(gov);
    assert.equal(st.isSymbolicLink(), false, 'qwen governance must be a COPY, never a symlink');
    assert.equal(st.isFile(), true);
    assert.equal(fs.statSync(gov).mode & 0o777, 0o444, 'governance copy is read-only 0444');
    assert.equal(
      sha256(fs.readFileSync(gov)),
      NEUTRAL_FP,
      'governed means the fingerprint MATCHES the source, not that a file exists',
    );
  });

  it('never links the operator settings.json, whose env block carries their key', () => {
    const settings = path.join(qwenHome(USER_ID), QWEN_SETTINGS_FILENAME);
    // The member's registry is written at spawn by qwen-settings-material.js; at
    // provision time the file is simply absent — and above all not a link.
    assert.equal(
      fs.lstatSync(settings, { throwIfNoEntry: false })?.isSymbolicLink(),
      undefined,
      'settings.json must not be a symlink into the operator tree',
    );
    assert.equal(
      fs.readFileSync(path.join(OPERATOR_QWEN, QWEN_SETTINGS_FILENAME), 'utf8'),
      OPERATOR_SETTINGS,
      'the operator settings file is untouched',
    );
  });

  it('reaps a legacy settings.json link and leaves the operator key behind it intact', () => {
    // A pre-fix tree could carry a link planted by an older pass. Unlinking must
    // drop the ENTRY and never follow it into the shared operator file.
    provisionUserDirs(OWNER_ID);
    const ownerSettings = path.join(qwenHome(OWNER_ID), QWEN_SETTINGS_FILENAME);
    fs.rmSync(ownerSettings, { force: true });
    fs.symlinkSync(path.join(OPERATOR_QWEN, QWEN_SETTINGS_FILENAME), ownerSettings);
    invalidateProvisioned(OWNER_ID);

    provisionUserDirs(OWNER_ID);

    assert.equal(
      fs.lstatSync(ownerSettings, { throwIfNoEntry: false })?.isSymbolicLink(),
      undefined,
      'the foreign link is gone',
    );
    assert.equal(
      fs.readFileSync(path.join(OPERATOR_QWEN, QWEN_SETTINGS_FILENAME), 'utf8'),
      OPERATOR_SETTINGS,
      'unlink never followed: the operator file still holds its own key',
    );
  });

  it('leaves the account side isolated — no operator session or usage state is linked', () => {
    const home = qwenHome(USER_ID);
    for (const entry of ['sessions', 'projects', 'usage', 'todos']) {
      assert.equal(
        fs.lstatSync(path.join(home, entry), { throwIfNoEntry: false })?.isSymbolicLink(),
        undefined,
        `${entry}/ must not be shared: only credentials and sessions stay per-user`,
      );
    }
  });

  it('is idempotent: a second pass preserves the links and the governance fingerprint', () => {
    provisionUserDirs(USER_ID);
    invalidateProvisioned(USER_ID);
    provisionUserDirs(USER_ID);

    const home = qwenHome(USER_ID);
    assert.equal(fs.lstatSync(path.join(home, 'memories')).isSymbolicLink(), true);
    assert.equal(sha256(fs.readFileSync(path.join(home, 'AGENTS.md'))), NEUTRAL_FP);
    assert.equal(fs.statSync(home).mode & 0o777, 0o700);
  });
});
