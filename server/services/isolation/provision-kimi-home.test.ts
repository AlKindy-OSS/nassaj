/**
 * provision-kimi-home.test.ts — the Kimi config-home block (M-1) and the governed
 * per-user opencode.json wiring (GL-2) in provisionUserDirs (ADR-062, W2-D config-seam).
 *
 * Proves:
 *  - a dedicated per-user KIMI_CODE_HOME (.kimi) is created with sessions/ and
 *    .kimi-code/ subdirs, and a real read-only (0444) AGENTS.md governance COPY whose
 *    fingerprint matches the neutral source (identity, not mere existence) — a COPY,
 *    never a symlink (write-through invariant), best-effort (kimi is enforced:false).
 *  - the Kimi block does not disturb the pre-existing Codex block (no regression).
 *  - opencode.json is materialized (0444, glm block) ONLY into a REAL per-user
 *    `.config/opencode` dir (post-GL-5 state), and is NEVER written THROUGH the shared
 *    operator symlink (pre-GL-5) — the write-through vector stays closed.
 *
 * HOME + DATABASE_PATH are sandboxed before importing any project module so the DB
 * singleton and userConfigDir never touch real state. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-kimi-home-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });

// Seed the neutral governance source from the REAL operator output when present,
// else a representative neutral stub — mirrors provision-codex-governance.test.ts.
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
const NASSAJ_CORE = path.join(sandboxHome, 'the governance repo');
fs.mkdirSync(NASSAJ_CORE, { recursive: true });
fs.writeFileSync(path.join(NASSAJ_CORE, 'AGENTS.md'), neutralContent);
fs.symlinkSync(NASSAJ_CORE, path.join(sandboxHome, '.claude'));

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');
const NEUTRAL_FP = sha256(neutralContent);

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');
const { serializeOpenCodeConfig, OPENCODE_CONFIG_FILENAME, GLM_CARRIER_BASE_URL } = await import(
  './opencode-config-material.js'
);

await initializeDatabase();

const OWNER_ID = 8101;
const USER_ID = 8102;
{
  const db = getConnection();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'owner')",
  ).run(OWNER_ID, 'kimi-owner');
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')",
  ).run(USER_ID, 'kimi-user');
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

const kimiHome = (id: number): string => userConfigDir(id, '.kimi');

describe('provisionUserDirs — Kimi config-home block (M-1)', () => {
  it('creates .kimi with sessions/ and .kimi-code/ subdirs (owner-only 0700)', () => {
    provisionUserDirs(USER_ID);
    const home = kimiHome(USER_ID);
    assert.equal(fs.statSync(home).isDirectory(), true, '.kimi (KIMI_CODE_HOME) exists');
    assert.equal(fs.statSync(home).mode & 0o777, 0o700, '.kimi is owner-only 0700');
    assert.equal(fs.statSync(path.join(home, 'sessions')).isDirectory(), true, 'sessions/ exists');
    assert.equal(
      fs.statSync(path.join(home, '.kimi-code')).isDirectory(),
      true,
      '.kimi-code/ (mcp.json home) exists',
    );
  });

  it('materializes AGENTS.md as a real read-only (0444) COPY matching the neutral source', () => {
    const gov = path.join(kimiHome(USER_ID), 'AGENTS.md');
    const st = fs.lstatSync(gov);
    assert.equal(st.isSymbolicLink(), false, 'kimi governance must be a COPY, never a symlink');
    assert.equal(st.isFile(), true);
    assert.equal(fs.statSync(gov).mode & 0o777, 0o444, 'governance copy is read-only 0444');
    assert.equal(
      sha256(fs.readFileSync(gov)),
      NEUTRAL_FP,
      'copy fingerprint equals the neutral source (identity)',
    );
  });

  it('does not disturb the Codex governance block (no cross-block regression)', () => {
    const codexGov = userConfigDir(USER_ID, path.join('.codex', 'AGENTS.md'));
    assert.equal(fs.lstatSync(codexGov).isFile(), true, 'Codex AGENTS.md still a real copy');
    assert.equal(sha256(fs.readFileSync(codexGov)), NEUTRAL_FP, 'Codex copy still matches source');
  });

  it('is idempotent for a fresh user', () => {
    const FRESH = 8103;
    getConnection()
      .prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')")
      .run(FRESH, 'kimi-fresh');
    provisionUserDirs(FRESH);
    provisionUserDirs(FRESH); // repeat pass must not throw or corrupt
    assert.equal(
      sha256(fs.readFileSync(path.join(kimiHome(FRESH), 'AGENTS.md'))),
      NEUTRAL_FP,
      'kimi governance intact after a repeat pass',
    );
  });
});

describe('provisionUserDirs — governed opencode.json (GL-2) write-through safety', () => {
  it('materializes a per-user opencode.json 0444 into a REAL .config/opencode dir (post-GL-5 state)', () => {
    // Simulate GL-5 having converted .config/opencode to a REAL per-user dir by
    // pre-creating it before provisioning; provisioning's ensureSymlink then no-ops
    // and the GL-2 materialization proceeds.
    const REALDIR_ID = 8104;
    getConnection()
      .prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')")
      .run(REALDIR_ID, 'oc-realdir');
    const ocDir = userConfigDir(REALDIR_ID, path.join('.config', 'opencode'));
    fs.mkdirSync(ocDir, { recursive: true });

    provisionUserDirs(REALDIR_ID);

    const ocFile = path.join(ocDir, OPENCODE_CONFIG_FILENAME);
    assert.equal(fs.lstatSync(ocFile).isSymbolicLink(), false, 'opencode.json is a real per-user file');
    assert.equal(fs.statSync(ocFile).mode & 0o777, 0o444, 'opencode.json is read-only 0444');
    const parsed = JSON.parse(fs.readFileSync(ocFile, 'utf8'));
    assert.ok(parsed.provider.glm, 'carries the custom glm provider block');
    // This test owns MATERIALIZATION, not the choice of URL: it asserts the file carries
    // the ONE carrier constant, and pins only the host — the property GL-3 allowlists.
    // Which URL that constant holds is pinned once, in vendor-config.agent-catalogs.test.
    assert.equal(parsed.provider.glm.options.baseURL, GLM_CARRIER_BASE_URL);
    assert.equal(new URL(parsed.provider.glm.options.baseURL).host, 'api.z.ai');
    assert.equal(fs.readFileSync(ocFile, 'utf8'), serializeOpenCodeConfig(), 'canonical content');
  });

  it('makes .config/opencode a REAL per-user dir even when the operator dir exists (GL-5), never writing opencode.json through', () => {
    // Post-GL-5: even with a real operator ~/.config/opencode present, provisioning
    // must NOT create a whole-dir symlink to it. It creates a REAL per-user dir and
    // materializes opencode.json THERE — the shared operator dir stays clean (the
    // write-through vector, in its new phrasing: the operator opencode.json is never
    // written through because the user dir is real, not a followed link).
    const operatorOc = path.join(sandboxHome, '.config', 'opencode');
    fs.mkdirSync(operatorOc, { recursive: true });

    const REAL_ID = 8105;
    getConnection()
      .prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')")
      .run(REAL_ID, 'oc-real');

    provisionUserDirs(REAL_ID);

    const userOcDir = userConfigDir(REAL_ID, path.join('.config', 'opencode'));
    assert.equal(
      fs.lstatSync(userOcDir).isSymbolicLink(),
      false,
      'GL-5: user .config/opencode is a REAL per-user dir, NOT the whole-dir operator symlink',
    );
    assert.equal(fs.statSync(userOcDir).isDirectory(), true, 'user .config/opencode is a real directory');
    // The per-user opencode.json is a real governed copy INSIDE the user dir…
    const userOcFile = path.join(userOcDir, OPENCODE_CONFIG_FILENAME);
    assert.equal(fs.lstatSync(userOcFile).isSymbolicLink(), false, 'per-user opencode.json is a real file');
    assert.ok(
      JSON.parse(fs.readFileSync(userOcFile, 'utf8')).provider.glm,
      'per-user opencode.json carries the glm provider block',
    );
    // …and the SHARED operator opencode.json is NEVER written through.
    assert.equal(
      fs.existsSync(path.join(operatorOc, OPENCODE_CONFIG_FILENAME)),
      false,
      'the shared operator opencode.json must NOT have been written through',
    );
  });

  it('self-heals a legacy pre-GL-5 whole-dir symlink into a REAL dir without touching the shared operator tree', () => {
    // MIGRATION: a node upgraded from a pre-GL-5 pass may carry a legacy whole-dir
    // symlink .config/opencode -> operator ~/.config/opencode. The GL-5 pass must
    // unlink the LINK (never follow it to write through), replace it with a real dir,
    // and materialize the per-user opencode.json there — leaving the shared operator
    // opencode.json absent.
    const operatorOc = path.join(sandboxHome, '.config', 'opencode');
    fs.mkdirSync(operatorOc, { recursive: true });

    const LEGACY_ID = 8106;
    getConnection()
      .prepare("INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')")
      .run(LEGACY_ID, 'oc-legacy');

    // Reproduce the legacy state: a whole-dir symlink to the operator config-home.
    const userOcDir = userConfigDir(LEGACY_ID, path.join('.config', 'opencode'));
    fs.mkdirSync(path.dirname(userOcDir), { recursive: true });
    fs.symlinkSync(operatorOc, userOcDir);
    assert.equal(fs.lstatSync(userOcDir).isSymbolicLink(), true, 'pre: legacy whole-dir symlink in place');

    provisionUserDirs(LEGACY_ID);

    // The link was replaced by a REAL dir…
    assert.equal(fs.lstatSync(userOcDir).isSymbolicLink(), false, 'GL-5 self-heal: symlink replaced by a real dir');
    assert.equal(fs.statSync(userOcDir).isDirectory(), true, 'user .config/opencode is now a real directory');
    // …the operator tree survived the unlink (rmSync unlinked the LINK, not the target)…
    assert.equal(fs.statSync(operatorOc).isDirectory(), true, 'shared operator dir survived the symlink removal');
    // …and opencode.json was written to the user dir, never through to the operator.
    assert.equal(
      fs.lstatSync(path.join(userOcDir, OPENCODE_CONFIG_FILENAME)).isSymbolicLink(),
      false,
      'per-user opencode.json is a real file after self-heal',
    );
    assert.equal(
      fs.existsSync(path.join(operatorOc, OPENCODE_CONFIG_FILENAME)),
      false,
      'the shared operator opencode.json must NOT have been written through during migration',
    );
  });
});
