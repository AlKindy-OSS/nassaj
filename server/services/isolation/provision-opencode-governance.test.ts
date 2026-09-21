/**
 * provision-opencode-governance.test.ts — the OpenCode carrier governance seam (GL-5,
 * ADR-062). Proves provisionUserDirs STOPS the old whole-dir governance symlink and
 * materializes a REAL per-user opencode config-home whose AGENTS.md is a real,
 * read-only (0444) COPY of the neutral source — never a followed symlink into the
 * shared, fleet-wide tree (the write-through vector a full-access carrier turn could
 * abuse, closed the same way as Codex's 2026-07-12 remediation):
 *
 *   ~/.nassaj-users/<id>/.config/opencode/            (a REAL per-user directory)
 *     AGENTS.md                                        (real 0444 COPY of ~/.claude/AGENTS.md)
 *     agent/, command/, skills/  ->  ~/.config/opencode/*   (SHARED non-security subdirs)
 *
 * This is what lets the governance badge honestly report opencode enforced:true (GL-7):
 * a symlink is no longer legitimate, so the badge's identity check (governanceMatchesSource,
 * the same primitive the fail-closed spawn gate uses) rejects it.
 *
 * Real path, not a synthetic fixture (lesson 2026-06-28): the sandbox reproduces the
 * production topology (~/.claude -> governance repo -> AGENTS.md), the neutral source is
 * seeded from the REAL operator governance when present, and every assertion exercises
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

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'nassaj-opencode-gov-test-'));
const ORIGINAL_HOME = process.env.HOME;
const ORIGINAL_DB = process.env.DATABASE_PATH;
const sandboxHome = path.join(sandbox, 'home');
fs.mkdirSync(sandboxHome, { recursive: true });

// Seed the neutral source from the REAL operator governance BEFORE overriding HOME.
let neutralContent: string;
try {
  neutralContent = fs.readFileSync(
    path.join(String(ORIGINAL_HOME), '.claude', 'AGENTS.md'),
    'utf8',
  );
} catch {
  neutralContent =
    '<!-- GENERATED — DO NOT EDIT -->\n# AGENTS.md — دليل وكلاء نسّاج (تعليمات مشتركة)\n' +
    'ملف تعليمات محايد المنصّة.\n';
}

process.env.HOME = sandboxHome;
process.env.DATABASE_PATH = path.join(sandbox, 'test-db.sqlite');

assert.equal(os.homedir(), sandboxHome, 'os.homedir() must honor the sandboxed $HOME');

// Production governance topology: sandboxHome/.claude -> governance repo -> AGENTS.md.
const NASSAJ_CORE = path.join(sandboxHome, 'governance-repo');
fs.mkdirSync(NASSAJ_CORE, { recursive: true });
fs.writeFileSync(path.join(NASSAJ_CORE, 'AGENTS.md'), neutralContent);
fs.symlinkSync(NASSAJ_CORE, path.join(sandboxHome, '.claude'));

// Operator opencode config-home with the shared, non-security subdirs GL-5 keeps as
// symlinks (agent/command/skills). AGENTS.md is deliberately NOT created here — the
// per-user COPY is the governance artifact, and we assert provisioning never writes
// one THROUGH into this operator dir.
const OPERATOR_OPENCODE = path.join(sandboxHome, '.config', 'opencode');
for (const sub of ['agent', 'command', 'skills']) {
  fs.mkdirSync(path.join(OPERATOR_OPENCODE, sub), { recursive: true });
}
fs.writeFileSync(path.join(OPERATOR_OPENCODE, 'skills', 'marker.md'), '# operator skill');

const sha256 = (buf: Buffer | string): string =>
  crypto.createHash('sha256').update(buf).digest('hex');
const NEUTRAL_FP = sha256(neutralContent);

const { initializeDatabase, closeConnection } = await import('@/modules/database/index.js');
const { provisionUserDirs, userConfigDir } = await import('./provision-user-dirs.js');

await initializeDatabase();

/** A user's isolated opencode config-home dir. */
function opencodeHome(userId: number): string {
  return userConfigDir(userId, path.join('.config', 'opencode'));
}
/** A user's isolated opencode AGENTS.md governance copy. */
function opencodeAgents(userId: number): string {
  return path.join(opencodeHome(userId), 'AGENTS.md');
}

after(() => {
  closeConnection();
  if (ORIGINAL_HOME === undefined) delete process.env.HOME;
  else process.env.HOME = ORIGINAL_HOME;
  if (ORIGINAL_DB === undefined) delete process.env.DATABASE_PATH;
  else process.env.DATABASE_PATH = ORIGINAL_DB;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

describe('provisionUserDirs — OpenCode carrier governance seam (GL-5, ADR-062)', () => {
  it('makes .config/opencode a REAL per-user directory, NOT the shared operator symlink', () => {
    const USER = 8501;
    provisionUserDirs(USER);
    const home = opencodeHome(USER);

    assert.equal(fs.existsSync(home), true, '.config/opencode must exist');
    assert.equal(
      fs.lstatSync(home).isSymbolicLink(),
      false,
      '.config/opencode must NOT be a whole-dir symlink into the shared operator tree',
    );
    assert.equal(fs.lstatSync(home).isDirectory(), true, '.config/opencode must be a real directory');
  });

  it('materializes AGENTS.md as a real 0444 COPY matching the neutral source (never a symlink)', () => {
    const USER = 8502;
    provisionUserDirs(USER);
    const gov = opencodeAgents(USER);

    assert.equal(fs.existsSync(gov), true, 'AGENTS.md must exist in the per-user opencode home');
    const st = fs.lstatSync(gov);
    assert.equal(
      st.isSymbolicLink(),
      false,
      'AGENTS.md must NOT be a symlink (a full-access carrier turn could write through it)',
    );
    assert.equal(st.isFile(), true, 'AGENTS.md must be a real regular file (a COPY)');
    assert.equal(st.mode & 0o777, 0o444, `governance copy must be 0444, got 0${(st.mode & 0o777).toString(8)}`);
    assert.equal(
      sha256(fs.readFileSync(gov)),
      NEUTRAL_FP,
      'the copy fingerprint must equal the neutral source (identity, not mere existence)',
    );
  });

  it('keeps the shared NON-security subdirs (agent/command/skills) as symlinks to the operator', () => {
    const USER = 8503;
    provisionUserDirs(USER);
    const home = opencodeHome(USER);

    for (const sub of ['agent', 'command', 'skills']) {
      const link = path.join(home, sub);
      assert.equal(fs.existsSync(link), true, `${sub} link should exist`);
      assert.equal(fs.lstatSync(link).isSymbolicLink(), true, `${sub} must be a symlink, not a real dir`);
      assert.equal(
        fs.realpathSync(link),
        fs.realpathSync(path.join(OPERATOR_OPENCODE, sub)),
        `${sub} must point at the operator's shared dir`,
      );
    }
    // Operator content is visible through the user's shared link.
    assert.equal(
      fs.existsSync(path.join(home, 'skills', 'marker.md')),
      true,
      'operator skills must be visible through the per-user link',
    );
  });

  it('does NOT write a governance file THROUGH into the shared operator opencode tree', () => {
    const USER = 8504;
    provisionUserDirs(USER);
    // The per-user copy exists, but the operator dir must have no AGENTS.md — proof the
    // per-user COPY never wrote through a link into the shared source.
    assert.equal(fs.existsSync(opencodeAgents(USER)), true, 'per-user copy exists');
    assert.equal(
      fs.existsSync(path.join(OPERATOR_OPENCODE, 'AGENTS.md')),
      false,
      'the shared operator opencode dir must never receive a written-through AGENTS.md',
    );
  });

  it('MIGRATION: converts a legacy whole-dir governance symlink into a real per-user dir + copy', () => {
    const USER = 8505;
    // Reproduce a pre-GL-5 node: .config/opencode is the shared operator whole-dir symlink.
    const userConfig = userConfigDir(USER, '.config');
    fs.mkdirSync(userConfig, { recursive: true });
    const home = opencodeHome(USER);
    fs.symlinkSync(OPERATOR_OPENCODE, home);
    assert.equal(fs.lstatSync(home).isSymbolicLink(), true, 'precondition: legacy whole-dir symlink planted');

    provisionUserDirs(USER);

    // GL-5 must have removed the link and replaced it with a real dir holding a real copy.
    assert.equal(
      fs.lstatSync(home).isSymbolicLink(),
      false,
      'the legacy whole-dir symlink must be removed (converted to a real dir)',
    );
    assert.equal(fs.lstatSync(home).isDirectory(), true, '.config/opencode must now be a real directory');
    const gov = opencodeAgents(USER);
    assert.equal(fs.lstatSync(gov).isSymbolicLink(), false, 'migrated AGENTS.md must be a real copy');
    assert.equal(sha256(fs.readFileSync(gov)), NEUTRAL_FP, 'migrated copy matches the neutral source');
    // The removal unlinked the LINK — the shared operator tree is intact.
    assert.equal(
      fs.existsSync(path.join(OPERATOR_OPENCODE, 'skills', 'marker.md')),
      true,
      'the shared operator opencode tree must be untouched by the migration',
    );
  });

  it('is idempotent: a repeat pass leaves a valid governance copy intact', () => {
    const USER = 8506;
    provisionUserDirs(USER);
    const gov = opencodeAgents(USER);
    assert.equal(fs.lstatSync(gov).isFile(), true, 'copy created on first pass');

    provisionUserDirs(USER);
    assert.equal(
      sha256(fs.readFileSync(gov)),
      NEUTRAL_FP,
      'copy still matches the neutral source after a repeat pass',
    );
  });
});
