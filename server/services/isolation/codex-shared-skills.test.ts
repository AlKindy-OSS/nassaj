/**
 * codex-shared-skills.test.ts — T-2000. Real-filesystem tests (no fs mocks) of
 * materializeSharedSkills against a synthetic mini core (dist/MANIFEST.json + two
 * skills, one carrying an executable script) and a temp Codex home. Home and core root
 * are injected, so no real operator path is read or written.
 *
 * A cross-check runs nassaj-core's scripts/sync-harness-homes --check (codex-skills)
 * against the JS-written home; it is skipped unless NASSAJ_CORE_DIR points at a core
 * that ships the script and python3 is available. Runner: node:test/tsx.
 */

import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, it } from 'node:test';

import {
  SKILLS_STATE_NAME,
  SKILLS_STATE_OWNER,
  materializeSharedSkills,
} from './codex-shared-skills.js';

type Fixture = { root: string; home: string; core: string; codexHome: string; skills: string };

const SKILL_FILES: Record<string, { body: string; mode: string }> = {
  'dist/portable/skills/alpha-skill/SKILL.md': {
    body: '---\nname: alpha-skill\ndescription: Alpha test skill\n---\n\nAlpha body.\n',
    mode: '0644',
  },
  'dist/portable/skills/beta-skill/SKILL.md': {
    body: '---\nname: beta-skill\ndescription: Beta test skill\n---\n\nBeta body.\n',
    mode: '0644',
  },
  'dist/portable/skills/beta-skill/scripts/run.sh': {
    body: '#!/bin/sh\necho beta\n',
    mode: '0755',
  },
};

let fx: Fixture;

function sha(data: string | Buffer): string {
  return crypto.createHash('sha256').update(data).digest('hex');
}

/** (Re)writes the mini core from `files` and a matching manifest. */
function writeCore(core: string, files: Record<string, { body: string; mode: string }>): void {
  fs.rmSync(path.join(core, 'dist'), { recursive: true, force: true });
  const manifest: Record<string, { sha256: string; mode: string }> = {};
  for (const [rel, { body, mode }] of Object.entries(files)) {
    const abs = path.join(core, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, body);
    fs.chmodSync(abs, Number.parseInt(mode, 8));
    manifest[rel] = { sha256: sha(body), mode };
  }
  fs.writeFileSync(
    path.join(core, 'dist', 'MANIFEST.json'),
    JSON.stringify({ generator: 'test', files: manifest }, null, 2),
  );
}

function run() {
  return materializeSharedSkills(fx.codexHome, { home: fx.home, coreRoot: fx.core });
}

function readState(): { owner: string; skills: string[] } {
  return JSON.parse(fs.readFileSync(path.join(fx.skills, SKILLS_STATE_NAME), 'utf8'));
}

beforeEach(() => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-skills-'));
  const home = path.join(root, 'home');
  fx = {
    root,
    home,
    core: path.join(root, 'core'),
    codexHome: path.join(root, 'users', 'u1', '.codex'),
    skills: path.join(root, 'users', 'u1', '.codex', 'skills'),
  };
  fs.mkdirSync(path.join(home, '.codex'), { recursive: true });
  fs.mkdirSync(fx.codexHome, { recursive: true });
  writeCore(fx.core, SKILL_FILES);
});

afterEach(() => {
  fs.rmSync(fx.root, { recursive: true, force: true });
});

describe('materializeSharedSkills', () => {
  it('copies every verified skill file with its exec bit and writes the state', () => {
    const res = run();
    assert.equal(res.ok, true);
    assert.equal(res.written, 3);
    const script = path.join(fx.skills, 'beta-skill', 'scripts', 'run.sh');
    assert.equal(fs.readFileSync(script, 'utf8'), SKILL_FILES['dist/portable/skills/beta-skill/scripts/run.sh'].body);
    assert.ok(fs.statSync(script).mode & 0o111, 'script must stay executable');
    const md = path.join(fx.skills, 'alpha-skill', 'SKILL.md');
    assert.equal(fs.statSync(md).mode & 0o111, 0);
    assert.deepEqual(readState(), { owner: SKILLS_STATE_OWNER, skills: ['alpha-skill', 'beta-skill'] });
  });

  it('is a no-op on a second run when nothing changed', () => {
    run();
    const statePath = path.join(fx.skills, SKILLS_STATE_NAME);
    const before = fs.statSync(statePath).mtimeMs;
    const res = run();
    assert.equal(res.ok, true);
    assert.equal(res.written, 0);
    assert.equal(res.removed, 0);
    assert.equal(fs.statSync(statePath).mtimeMs, before);
  });

  it('replaces a symlinked file with a real file', () => {
    run();
    const md = path.join(fx.skills, 'alpha-skill', 'SKILL.md');
    const decoy = path.join(fx.root, 'decoy.md');
    fs.writeFileSync(decoy, 'decoy');
    fs.rmSync(md);
    fs.symlinkSync(decoy, md);
    const res = run();
    assert.equal(res.written, 1);
    assert.equal(fs.lstatSync(md).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(decoy, 'utf8'), 'decoy', 'symlink target must not be written');
  });

  it('removes an owned skill dropped from the source', () => {
    run();
    const { 'dist/portable/skills/alpha-skill/SKILL.md': _dropped, ...rest } = SKILL_FILES;
    writeCore(fx.core, rest);
    const res = run();
    assert.equal(res.ok, true);
    assert.equal(fs.existsSync(path.join(fx.skills, 'alpha-skill')), false);
    assert.deepEqual(readState().skills, ['beta-skill']);
  });

  it('removes a stale file inside an owned skill', () => {
    run();
    const stale = path.join(fx.skills, 'beta-skill', 'scripts', 'old.sh');
    fs.writeFileSync(stale, 'old');
    const res = run();
    assert.equal(res.removed, 1);
    assert.equal(fs.existsSync(stale), false);
  });

  it('never touches .system or an unowned same-name dir, and excludes it from state', () => {
    const sys = path.join(fx.skills, '.system', 'vendor-skill', 'SKILL.md');
    const foreign = path.join(fx.skills, 'alpha-skill', 'SKILL.md');
    const extra = path.join(fx.skills, 'alpha-skill', 'notes.txt');
    fs.mkdirSync(path.dirname(sys), { recursive: true });
    fs.mkdirSync(path.dirname(foreign), { recursive: true });
    fs.writeFileSync(sys, 'vendor');
    fs.writeFileSync(foreign, 'hand-made');
    fs.writeFileSync(extra, 'keep');
    const res = run();
    assert.equal(res.ok, true);
    assert.deepEqual(res.blocked, ['alpha-skill']);
    assert.equal(fs.readFileSync(sys, 'utf8'), 'vendor');
    assert.equal(fs.readFileSync(foreign, 'utf8'), 'hand-made');
    assert.equal(fs.readFileSync(extra, 'utf8'), 'keep');
    assert.deepEqual(readState().skills, ['beta-skill']);
  });

  it('writes nothing and returns ok:false on a manifest sha mismatch', () => {
    fs.writeFileSync(path.join(fx.core, 'dist/portable/skills/alpha-skill/SKILL.md'), 'tampered');
    const res = run();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'source_verification_failed');
    assert.equal(fs.existsSync(fx.skills), false);
  });

  it('returns ok:false without throwing when the source is missing', () => {
    fs.rmSync(fx.core, { recursive: true, force: true });
    const res = run();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'manifest_unavailable');
    assert.equal(fs.existsSync(fx.skills), false);
  });

  it('skips the operator Codex home', () => {
    const res = materializeSharedSkills(path.join(fx.home, '.codex'), { home: fx.home, coreRoot: fx.core });
    assert.equal(res.ok, true);
    assert.equal(res.skipped, true);
    assert.equal(fs.existsSync(path.join(fx.home, '.codex', 'skills')), false);
  });

  it('replaces an owned skill dir symlinked outside without touching the outside', () => {
    run();
    const victim = path.join(fx.root, 'victim');
    fs.mkdirSync(victim);
    fs.writeFileSync(path.join(victim, 'SKILL.md'), SKILL_FILES['dist/portable/skills/alpha-skill/SKILL.md'].body);
    fs.writeFileSync(path.join(victim, 'precious.txt'), 'keep');
    const skillDir = path.join(fx.skills, 'alpha-skill');
    fs.rmSync(skillDir, { recursive: true });
    fs.symlinkSync(victim, skillDir);
    const res = run();
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(path.join(victim, 'precious.txt'), 'utf8'), 'keep');
    assert.ok(fs.existsSync(path.join(victim, 'SKILL.md')));
    assert.equal(fs.lstatSync(skillDir).isDirectory(), true, 'link replaced by a real dir');
    assert.deepEqual(fs.readdirSync(skillDir), ['SKILL.md']);
  });

  it('replaces a symlinked subdir inside a managed skill with a real dir', () => {
    run();
    const outside = path.join(fx.root, 'outside-scripts');
    fs.mkdirSync(outside);
    const scriptBody = SKILL_FILES['dist/portable/skills/beta-skill/scripts/run.sh'].body;
    fs.writeFileSync(path.join(outside, 'run.sh'), scriptBody, { mode: 0o755 });
    fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
    const sub = path.join(fx.skills, 'beta-skill', 'scripts');
    fs.rmSync(sub, { recursive: true });
    fs.symlinkSync(outside, sub);
    const res = run();
    assert.equal(res.ok, true);
    assert.equal(fs.lstatSync(sub).isDirectory(), true);
    assert.equal(fs.readFileSync(path.join(sub, 'run.sh'), 'utf8'), scriptBody);
    assert.deepEqual(fs.readdirSync(outside).sort(), ['precious.txt', 'run.sh']);
  });

  it('refuses when skills/ itself is a symlink and writes nothing', () => {
    const outside = path.join(fx.root, 'outside-skills');
    fs.mkdirSync(outside);
    fs.symlinkSync(outside, fx.skills);
    const res = run();
    assert.equal(res.ok, false);
    assert.equal(res.reason, 'skills_root_symlink');
    assert.deepEqual(fs.readdirSync(outside), []);
  });

  for (const bad of ['dist/portable/skills/../escape/SKILL.md', 'dist/portable/skills/.hidden/SKILL.md']) {
    it(`rejects unsafe manifest path ${bad}`, () => {
      const manifestPath = path.join(fx.core, 'dist', 'MANIFEST.json');
      const doc = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
      doc.files[bad] = { sha256: sha('x'), mode: '0644' };
      fs.writeFileSync(manifestPath, JSON.stringify(doc));
      const res = run();
      assert.equal(res.ok, false);
      assert.ok(res.problems?.some((p: string) => p.startsWith('unsafe_path')));
      assert.equal(fs.existsSync(fx.skills), false);
    });
  }

  const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;
  it('returns write_failed when the skills dir is read-only', { skip: isRoot }, () => {
    fs.mkdirSync(fx.skills);
    fs.chmodSync(fx.skills, 0o555);
    try {
      const res = run();
      assert.equal(res.ok, false);
      assert.equal(res.reason, 'write_failed');
    } finally {
      fs.chmodSync(fx.skills, 0o755);
    }
  });

  it('survives a corrupt state file', () => {
    fs.mkdirSync(fx.skills);
    fs.writeFileSync(path.join(fx.skills, SKILLS_STATE_NAME), '{not json');
    const res = run();
    assert.equal(res.ok, true);
    assert.deepEqual(readState().skills, ['alpha-skill', 'beta-skill']);
  });

  it('ignores malicious names in the state file', () => {
    const sys = path.join(fx.skills, '.system', 'vendor-skill', 'SKILL.md');
    const outsideFile = path.join(fx.codexHome, 'x', 'keep.txt');
    fs.mkdirSync(path.dirname(sys), { recursive: true });
    fs.mkdirSync(path.dirname(outsideFile), { recursive: true });
    fs.writeFileSync(sys, 'vendor');
    fs.writeFileSync(outsideFile, 'keep');
    fs.writeFileSync(
      path.join(fx.skills, SKILLS_STATE_NAME),
      JSON.stringify({ owner: SKILLS_STATE_OWNER, skills: ['../x', '.system', '..'] }),
    );
    const res = run();
    assert.equal(res.ok, true);
    assert.equal(fs.readFileSync(sys, 'utf8'), 'vendor');
    assert.equal(fs.readFileSync(outsideFile, 'utf8'), 'keep');
  });

  it('returns ok:false for an invalid codex home', () => {
    assert.equal(materializeSharedSkills('', { home: fx.home, coreRoot: fx.core }).ok, false);
  });
});

const coreDir = process.env.NASSAJ_CORE_DIR ?? '';
const syncScript = coreDir ? path.join(coreDir, 'scripts', 'sync-harness-homes') : '';
const python = spawnSync('python3', ['--version']);
const crossCheckReady = Boolean(syncScript) && fs.existsSync(syncScript) && python.status === 0;

describe('cross-check with scripts/sync-harness-homes', () => {
  it('reports no codex-skills drift on the JS-written home', { skip: !crossCheckReady }, () => {
    assert.equal(run().ok, true);
    const res = spawnSync('python3', [
      syncScript, '--repo', fx.core, '--home', fx.home, '--codex-home', fx.codexHome,
      '--only', 'codex-skills', '--check',
    ], { encoding: 'utf8' });
    assert.equal(res.status, 0, `${res.stdout}\n${res.stderr}`);
  });
});
