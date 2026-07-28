/**
 * provision-codex-governance.test.ts — Codex governance decoupling (ADR-057 / T-819),
 * hardened by the 2026-07-12 remediation: governance is a real read-only COPY, NOT a
 * symlink.
 *
 * Proves provisionUserDirs materializes the NEUTRAL nassaj governance into each user's
 * isolated CODEX_HOME as a real, read-only (0444) file whose content matches the
 * neutral source:
 *   ~/.nassaj-users/<id>/.codex/AGENTS.md  (copy of)  ~/.claude/AGENTS.md
 * A COPY (never a symlink) is the security invariant: a Codex turn runs
 * danger-full-access, and a symlink to the shared fleet-wide source could be written
 * THROUGH and corrupt governance for every user on the node. The source itself is
 * ~/.claude/AGENTS.md, which bootstrap-node.sh points at nassaj-core/AGENTS.md — the
 * build-agents neutral output a spawned Codex reads from $CODEX_HOME/AGENTS.md.
 *
 * Real path, not a synthetic fixture: the sandbox reproduces the production topology
 * (the double hop ~/.claude -> nassaj-core -> AGENTS.md), the neutral source is
 * seeded from the REAL operator nassaj-core/AGENTS.md content when present (so "the
 * neutral source" is genuine governance, not a stub), and every assertion exercises
 * real fs materialization through the real provisionUserDirs code.
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-codex-gov-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });

// Seed the neutral source from the REAL operator governance BEFORE overriding HOME,
// so "the neutral source" under test is the genuine build-agents output. Falls back
// to a representative neutral marker on a bare CI node without nassaj-core.
let neutralContent: string;
// True when seeded from the REAL operator build-agents output (a fleet node); false on
// the bare-CI fallback stub. The stub carries no standards body (so no safe-restart
// rule), so the positive presence assertion below is guarded by this flag.
let neutralIsRealGovernance: boolean;
try {
  neutralContent = fs.readFileSync(
    path.join(String(ORIGINAL_HOME), '.claude', 'AGENTS.md'),
    'utf8',
  );
  neutralIsRealGovernance = true;
} catch {
  neutralContent =
    '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج (تعليمات مشتركة)\n' +
    'ملف تعليمات محايد المنصّة.\n';
  neutralIsRealGovernance = false;
}

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Reproduce the production governance topology faithfully:
//   sandboxHome/.claude  ->  sandboxHome/nassaj-core   (whole-dir symlink, as bootstrap wires it)
//   sandboxHome/nassaj-core/AGENTS.md                  (build-agents neutral output)
const NASSAJ_CORE = path.join(sandboxHome, 'nassaj-core');
fs.mkdirSync(NASSAJ_CORE, { recursive: true });
const NEUTRAL_AGENTS = path.join(NASSAJ_CORE, 'AGENTS.md');
fs.writeFileSync(NEUTRAL_AGENTS, neutralContent);
fs.symlinkSync(NASSAJ_CORE, path.join(sandboxHome, '.claude'));

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');
const NEUTRAL_FP = sha256(neutralContent);

const { initializeDatabase, closeConnection, getConnection } = await import(
  '@/modules/database/index.js'
);
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

await initializeDatabase();

// Seed an owner and a regular user.
const OWNER_ID = 8001;
const USER_ID = 8002;
{
  const db = getConnection();
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'owner')"
  ).run(OWNER_ID, 'codex-gov-owner');
  db.prepare(
    "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
  ).run(USER_ID, 'codex-gov-user');
}

/** Path to a user's isolated CODEX_HOME AGENTS.md governance file. */
function codexAgents(userId: number): string {
  return userConfigDir(userId, path.join('.codex', 'AGENTS.md'));
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('provisionUserDirs — Codex neutral governance materialization (ADR-057, copy hardening)', () => {
  it('materializes AGENTS.md into the owner isolated CODEX_HOME as a real file matching the source', () => {
    provisionUserDirs(OWNER_ID);
    const gov = codexAgents(OWNER_ID);

    assert.equal(fs.existsSync(gov), true, 'AGENTS.md must exist in the isolated CODEX_HOME');
    const st = fs.lstatSync(gov);
    assert.equal(
      st.isSymbolicLink(),
      false,
      'AGENTS.md must NOT be a symlink (a full-access turn could write through it to the fleet source)',
    );
    assert.equal(st.isFile(), true, 'AGENTS.md must be a real regular file (a COPY)');
    assert.equal(
      sha256(fs.readFileSync(gov)),
      NEUTRAL_FP,
      'the copy fingerprint must equal the neutral source (identity, not mere existence)',
    );
  });

  it('materializes the governance copy read-only (0444) to signal intent and stop naive writes', () => {
    const gov = codexAgents(OWNER_ID);
    const mode = fs.statSync(gov).mode & 0o777;
    assert.equal(mode, 0o444, `governance copy must be 0444, got 0${mode.toString(8)}`);
  });

  it('serves the exact neutral content, with NO Claude-only mechanics', () => {
    const served = fs.readFileSync(codexAgents(OWNER_ID), 'utf8');
    assert.equal(served, neutralContent, 'copy content must equal the neutral source byte-for-byte');
    // "safe-restart" was REMOVED from this forbidden list on 2026-07-16 (OC-09 / T-858):
    // the neutral standards now carry a platform-AGNOSTIC operational-safety rule — route
    // sensitive production ops through the project's approved safe path (e.g.
    // scripts/safe-restart.sh) instead of raw restart commands that could lock the port /
    // drop the service. That rule is shared by EVERY engine's governance (even the
    // opencode governance plugin exempts safe-restart.sh); it is not a Claude-only
    // mechanic. The tokens below remain genuinely Claude-only.
    for (const token of ['/compact', 'ultracode', 'CLAUDE_CONFIG_DIR']) {
      assert.equal(
        served.includes(token),
        false,
        `neutral governance served to Codex must not contain the Claude-only token "${token}"`,
      );
    }
    // Positive counterpart (OC-09 / T-858, 2026-07-16): the neutral safe-restart rule is
    // legitimate shared governance, so on a real-governance node it MUST reach Codex —
    // proving it is genuinely served, not stripped as if it were still forbidden. (The
    // bare-CI fallback stub has no standards body, so this presence check is guarded.)
    if (neutralIsRealGovernance) {
      assert.equal(
        served.includes('safe-restart'),
        true,
        'neutral governance served to Codex must carry the shared safe-restart operational-safety rule',
      );
    }
  });

  it('materializes the SAME neutral content for a non-owner user (shared governance, no drift)', () => {
    provisionUserDirs(USER_ID);
    const gov = codexAgents(USER_ID);

    assert.equal(
      fs.lstatSync(gov).isSymbolicLink(),
      false,
      'non-owner AGENTS.md must also be a real copy, never a symlink',
    );
    assert.equal(
      sha256(fs.readFileSync(gov)),
      sha256(fs.readFileSync(codexAgents(OWNER_ID))),
      'owner and non-owner copies must share the SAME neutral fingerprint (no per-user drift)',
    );
  });

  it('is idempotent: re-provisioning a fresh user leaves a valid copy intact', () => {
    const FRESH = 8003;
    const db = getConnection();
    db.prepare(
      "INSERT OR IGNORE INTO users (id, username, password_hash, role) VALUES (?, ?, 'x', 'user')"
    ).run(FRESH, 'codex-gov-fresh');

    provisionUserDirs(FRESH);
    const gov = codexAgents(FRESH);
    assert.equal(fs.lstatSync(gov).isFile(), true, 'copy created on first pass');

    // A repeat pass must be a no-op (never throw, never corrupt the copy).
    provisionUserDirs(FRESH);
    assert.equal(
      sha256(fs.readFileSync(gov)),
      NEUTRAL_FP,
      'copy still matches the neutral source after a repeat pass',
    );
  });
});
