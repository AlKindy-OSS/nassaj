/**
 * harness-files-private-store.test — ADR-203 stage C2 on a real filesystem and
 * a real database under a sandbox HOME: the private store and its seed, path
 * and cap rules, the Claude link reconcile (live sessions, legacy dirs, kill
 * switch), the per-user lock, and the Codex private materialization.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before, beforeEach } from 'node:test';

import {
  closeConnection,
  harnessFilesModeDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';

import {
  reconcileClaudeSkillsForEnv,
  reconcileClaudeSkillsLink,
  repointSymlink,
  userIdFromUserHome,
} from './claude-skills-link.js';
import { SKILLS_STATE_NAME } from './codex-shared-skills.js';
import { materializeCodexSkillsForLaunch } from './codex-skills-launch.js';
import { withHarnessFilesLock } from './harness-files-lock.js';
import { PRIVATE_SKILLS_FLAG } from './harness-files-mode.js';
import { scanLiveClaudeSessions, setLiveClaudeSessionProbeForTest } from './live-claude-sessions.js';
import {
  PrivateStoreError,
  privateSkillsStoreRoot,
  readPrivateSkillSources,
  resolvePrivateSkillTarget,
  seedPrivateSkillsStore,
} from './private-skills-store.js';

let home = '';
let dbDir = '';
let originalHome: string | undefined;
let userId = 0;
let liveDirs = new Set<string>();

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} test\n---\n\nbody\n`;
const claudeLibrary = () => path.join(home, '.claude', 'skills');
const userClaude = (id = userId) => path.join(home, '.nassaj-users', String(id), '.claude');
const userCodex = (id = userId) => path.join(home, '.nassaj-users', String(id), '.codex');

function writeFile(target: string, body: string | Buffer, mode = 0o644): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
  fs.chmodSync(target, mode);
}

/** Shared Claude library: two skills, plus entries the seed must exclude. */
function writeClaudeLibrary(): void {
  writeFile(path.join(claudeLibrary(), 'alpha', 'SKILL.md'), skillMd('alpha'));
  writeFile(path.join(claudeLibrary(), 'alpha', 'scripts', 'run.sh'), '#!/bin/sh\n', 0o755);
  writeFile(path.join(claudeLibrary(), 'beta', 'SKILL.md'), skillMd('beta'));
  writeFile(path.join(claudeLibrary(), 'INDEX.md'), '# index\n');
  writeFile(path.join(claudeLibrary(), 'LICENSES', 'MIT.txt'), 'mit\n');
  writeFile(path.join(claudeLibrary(), 'synced', 'SKILL.md'), skillMd('synced'));
  writeFile(path.join(claudeLibrary(), 'nodoc', 'README.md'), 'no skill file\n');
  const outside = path.join(home, 'outside-skill');
  writeFile(path.join(outside, 'SKILL.md'), skillMd('outside'));
  fs.symlinkSync(outside, path.join(claudeLibrary(), 'linked'));
  fs.symlinkSync(path.join(outside, 'SKILL.md'), path.join(claudeLibrary(), 'beta', 'leak.md'));
}

/** Mini nassaj-core with a manifest-verified portable skill set. */
function writeCore(): string {
  const core = path.join(home, 'core');
  const files: Record<string, string> = {
    'dist/portable/skills/gamma/SKILL.md': skillMd('gamma'),
    'dist/portable/skills/delta/SKILL.md': skillMd('delta'),
  };
  const manifest: Record<string, { sha256: string; mode: string }> = {};
  for (const [rel, body] of Object.entries(files)) {
    writeFile(path.join(core, rel), body);
    manifest[rel] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), mode: '0644' };
  }
  writeFile(path.join(core, 'dist', 'MANIFEST.json'), JSON.stringify({ files: manifest }));
  return core;
}

function provisionClaudeLink(id = userId): string {
  fs.mkdirSync(userClaude(id), { recursive: true });
  const link = path.join(userClaude(id), 'skills');
  if (!fs.existsSync(link)) fs.symlinkSync(claudeLibrary(), link);
  return link;
}

before(async () => {
  originalHome = process.env.HOME;
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-store-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();
  const created = userDb.createUser('hf_store_owner', 'hash', 'user') as { id: number };
  userDb.setRole(created.id, 'owner');
  userId = created.id;
  setLiveClaudeSessionProbeForTest((dir) => liveDirs.has(path.resolve(dir)));
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-store-home-'));
  process.env.HOME = home;
  writeClaudeLibrary();
  process.env.NASSAJ_CORE_DIR = writeCore();
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  harnessFilesModeDb.setStoredMode(userId, 'shared');
  liveDirs = new Set();
});

afterEach(() => {
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.NASSAJ_CORE_DIR;
  delete process.env[PRIVATE_SKILLS_FLAG];
});

after(() => {
  setLiveClaudeSessionProbeForTest(null);
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('Claude seed copies real skill dirs with SKILL.md only, never through a symlink', () => {
  const result = seedPrivateSkillsStore(userId, 'claude');
  assert.deepEqual(result, { seeded: true, skills: 2 });
  const store = privateSkillsStoreRoot(userId, 'claude');
  assert.deepEqual(fs.readdirSync(store).sort(), ['alpha', 'beta']);
  assert.equal(fs.existsSync(path.join(store, 'beta', 'leak.md')), false);
  assert.ok(fs.existsSync(path.join(store, 'alpha', '.nassaj-skill.json')));
  assert.equal(fs.statSync(path.join(store, 'alpha', 'scripts', 'run.sh')).mode & 0o777, 0o700);
  assert.equal(fs.statSync(store).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.dirname(path.dirname(store))).mode & 0o777, 0o700);
});

test('an existing store is reused and never overwritten', () => {
  seedPrivateSkillsStore(userId, 'claude');
  const store = privateSkillsStoreRoot(userId, 'claude');
  fs.writeFileSync(path.join(store, 'alpha', 'SKILL.md'), skillMd('alpha-mine'));
  fs.rmSync(path.join(store, 'beta'), { recursive: true });
  assert.deepEqual(seedPrivateSkillsStore(userId, 'claude'), { seeded: false, skills: 0 });
  assert.match(fs.readFileSync(path.join(store, 'alpha', 'SKILL.md'), 'utf8'), /alpha-mine/);
  assert.equal(fs.existsSync(path.join(store, 'beta')), false);
});

test('Codex seed uses the manifest-verified portable set; tampering is refused', () => {
  assert.deepEqual(seedPrivateSkillsStore(userId, 'codex'), { seeded: true, skills: 2 });
  assert.deepEqual(fs.readdirSync(privateSkillsStoreRoot(userId, 'codex')).sort(), ['delta', 'gamma']);
  const other = userDb.createUser('hf_store_codex', 'hash', 'user') as { id: number };
  fs.appendFileSync(path.join(String(process.env.NASSAJ_CORE_DIR), 'dist/portable/skills/gamma/SKILL.md'), 'x');
  assert.throws(() => seedPrivateSkillsStore(other.id, 'codex'),
    (err: unknown) => err instanceof PrivateStoreError && err.code === 'seed_source_unverified');
});

test('Codex seed refuses an unresolvable nassaj-core root and creates no store', () => {
  delete process.env.NASSAJ_CORE_DIR;
  assert.throws(() => seedPrivateSkillsStore(userId, 'codex'),
    (err: unknown) => err instanceof PrivateStoreError && err.code === 'seed_source_unavailable');
  assert.equal(fs.existsSync(privateSkillsStoreRoot(userId, 'codex')), false);
  harnessFilesModeDb.setStoredMode(userId, 'private');
  assert.equal(materializeCodexSkillsForLaunch(userCodex()).reason, 'private_source_unavailable');
});

test('caps: oversized file, too many files and too deep a tree fail the seed', () => {
  const cases: [string, () => void][] = [
    ['file_bytes', () => writeFile(path.join(claudeLibrary(), 'alpha', 'big.bin'), Buffer.alloc(1024 * 1024 + 1))],
    ['skill_files', () => {
      for (let i = 0; i < 201; i += 1) writeFile(path.join(claudeLibrary(), 'beta', 'many', `f${i}.txt`), 'x');
    }],
    ['depth', () => writeFile(path.join(claudeLibrary(), 'alpha', 'a', 'b', 'c', 'd', 'e', 'f', 'g.txt'), 'x')],
  ];
  for (const [detail, arrange] of cases) {
    fs.rmSync(claudeLibrary(), { recursive: true, force: true });
    writeClaudeLibrary();
    arrange();
    const fresh = userDb.createUser(`hf_cap_${detail}`, 'hash', 'user') as { id: number };
    assert.throws(() => seedPrivateSkillsStore(fresh.id, 'claude'),
      (err: unknown) => err instanceof PrivateStoreError && err.code === 'cap_exceeded' && err.detail === detail);
    assert.equal(fs.existsSync(privateSkillsStoreRoot(fresh.id, 'claude')), false);
  }
});

test('store-size cap: more than 8 MiB in total fails', () => {
  for (let i = 0; i < 9; i += 1) writeFile(path.join(claudeLibrary(), 'alpha', `chunk${i}.bin`), Buffer.alloc(1024 * 1024));
  assert.throws(() => seedPrivateSkillsStore(userId, 'claude'),
    (err: unknown) => err instanceof PrivateStoreError && err.detail === 'store_bytes');
});

test('path spoofing: unsafe names and a symlink in any component are rejected', () => {
  for (const name of ['..', '.hidden', 'a/b', '', 'x\\y']) {
    assert.throws(() => resolvePrivateSkillTarget(userId, 'claude', name), PrivateStoreError);
  }
  assert.throws(() => privateSkillsStoreRoot('1/../2', 'claude'), PrivateStoreError);
  assert.throws(() => privateSkillsStoreRoot(userId, 'qwen' as 'claude'), PrivateStoreError);
  const elsewhere = path.join(home, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.mkdirSync(path.join(home, '.nassaj-users', String(userId)), { recursive: true });
  fs.symlinkSync(elsewhere, path.join(home, '.nassaj-users', String(userId), '.nassaj-private'));
  assert.throws(() => seedPrivateSkillsStore(userId, 'claude'),
    (err: unknown) => err instanceof PrivateStoreError && err.code === 'path_rejected');
  assert.throws(() => resolvePrivateSkillTarget(userId, 'claude', 'alpha'), PrivateStoreError);
  assert.deepEqual(fs.readdirSync(elsewhere), []);
});

test('a symlinked skill folder inside the store is rejected as a write target', () => {
  seedPrivateSkillsStore(userId, 'claude');
  const store = privateSkillsStoreRoot(userId, 'claude');
  fs.symlinkSync(path.join(home, 'outside-skill'), path.join(store, 'sneaky'));
  assert.throws(() => resolvePrivateSkillTarget(userId, 'claude', 'sneaky'), PrivateStoreError);
  assert.equal(resolvePrivateSkillTarget(userId, 'claude', 'fresh'), path.join(store, 'fresh'));
});

test('repointSymlink: legacy real dir and skills.bak-* siblings are never touched', () => {
  fs.mkdirSync(path.join(userClaude(), 'skills', 'mine'), { recursive: true });
  fs.mkdirSync(path.join(userClaude(), 'skills.bak-0510', 'old'), { recursive: true });
  seedPrivateSkillsStore(userId, 'claude');
  assert.equal(repointSymlink(path.join(userClaude(), 'skills'), privateSkillsStoreRoot(userId, 'claude')), 'legacy-real-dir');
  harnessFilesModeDb.setStoredMode(userId, 'private');
  assert.equal(reconcileClaudeSkillsLink(userId), 'legacy-real-dir');
  assert.ok(fs.lstatSync(path.join(userClaude(), 'skills')).isDirectory());
  assert.deepEqual(fs.readdirSync(path.join(userClaude(), 'skills')), ['mine']);
  assert.deepEqual(fs.readdirSync(path.join(userClaude(), 'skills.bak-0510')), ['old']);
});

test('reconcile: private repoints, kill switch 0 repoints back, data survives', () => {
  const link = provisionClaudeLink();
  harnessFilesModeDb.setStoredMode(userId, 'private');
  assert.equal(reconcileClaudeSkillsLink(userId), 'repointed');
  assert.equal(fs.readlinkSync(link), privateSkillsStoreRoot(userId, 'claude'));
  assert.equal(reconcileClaudeSkillsLink(userId), 'in-sync');
  fs.writeFileSync(path.join(privateSkillsStoreRoot(userId, 'claude'), 'alpha', 'notes.md'), 'mine');
  process.env[PRIVATE_SKILLS_FLAG] = '0';
  assert.equal(reconcileClaudeSkillsForEnv({ CLAUDE_CONFIG_DIR: userClaude() }), 'repointed');
  assert.equal(fs.readlinkSync(link), claudeLibrary());
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  assert.equal(reconcileClaudeSkillsLink(userId), 'repointed');
  assert.equal(fs.readFileSync(path.join(link, 'alpha', 'notes.md'), 'utf8'), 'mine');
});

test('a live Claude session of the user defers the repoint; the next launch applies it', () => {
  const link = provisionClaudeLink();
  harnessFilesModeDb.setStoredMode(userId, 'private');
  liveDirs.add(path.resolve(userClaude()));
  assert.equal(reconcileClaudeSkillsLink(userId), 'deferred-live-session');
  assert.equal(fs.readlinkSync(link), claudeLibrary());
  liveDirs.clear();
  assert.equal(reconcileClaudeSkillsLink(userId), 'repointed');
});

test('a foreign link target is left alone', () => {
  fs.mkdirSync(userClaude(), { recursive: true });
  const custom = path.join(home, 'custom-skills');
  fs.mkdirSync(custom);
  fs.symlinkSync(custom, path.join(userClaude(), 'skills'));
  harnessFilesModeDb.setStoredMode(userId, 'private');
  assert.equal(reconcileClaudeSkillsLink(userId), 'foreign-link');
  assert.equal(fs.readlinkSync(path.join(userClaude(), 'skills')), custom);
});

test('the per-user lock defers a launch-time reconcile', async () => {
  const link = provisionClaudeLink();
  harnessFilesModeDb.setStoredMode(userId, 'private');
  await withHarnessFilesLock(userId, () => {
    assert.equal(reconcileClaudeSkillsLink(userId), 'deferred-locked');
    assert.equal(materializeCodexSkillsForLaunch(userCodex()).reason, 'deferred_locked');
  });
  assert.equal(fs.readlinkSync(link), claudeLibrary());
});

test('owner id is parsed only from ~/.nassaj-users/<id>/<sub>', () => {
  assert.equal(userIdFromUserHome(userClaude(), '.claude'), userId);
  assert.equal(userIdFromUserHome(path.join(home, '.claude'), '.claude'), null);
  assert.equal(userIdFromUserHome(path.join(home, '.nassaj-users', '0', '.claude'), '.claude'), null);
  assert.equal(userIdFromUserHome(path.join(home, '.nassaj-users', '3', '..', '4', '.claude'), '.claude'), 4);
  assert.equal(reconcileClaudeSkillsForEnv({}), 'not-a-user-home');
});

test('Codex private mode replaces owned shared skills, never unowned dirs or .system', () => {
  const codexSkills = path.join(userCodex(), 'skills');
  assert.equal(materializeCodexSkillsForLaunch(userCodex()).ok, true);
  writeFile(path.join(codexSkills, 'hand-made', 'SKILL.md'), skillMd('hand-made'));
  writeFile(path.join(codexSkills, '.system', 'sys', 'SKILL.md'), skillMd('sys'));
  harnessFilesModeDb.setStoredMode(userId, 'private');
  seedPrivateSkillsStore(userId, 'codex');
  const store = privateSkillsStoreRoot(userId, 'codex');
  fs.rmSync(path.join(store, 'delta'), { recursive: true });
  writeFile(path.join(store, 'mine', 'SKILL.md'), skillMd('mine'));
  writeFile(path.join(store, 'hand-made', 'SKILL.md'), skillMd('collides'));
  fs.symlinkSync(path.join(home, 'outside-skill'), path.join(store, 'linked'));
  const result = materializeCodexSkillsForLaunch(userCodex());
  assert.equal(result.ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(codexSkills, SKILLS_STATE_NAME), 'utf8'));
  assert.equal(state.mode, 'private');
  assert.deepEqual(state.skills, ['gamma', 'mine']);
  assert.equal(fs.existsSync(path.join(codexSkills, 'delta')), false);
  assert.match(fs.readFileSync(path.join(codexSkills, 'hand-made', 'SKILL.md'), 'utf8'), /hand-made/);
  assert.ok(fs.existsSync(path.join(codexSkills, '.system', 'sys', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(codexSkills, 'linked')), false);
  harnessFilesModeDb.setStoredMode(userId, 'shared');
  materializeCodexSkillsForLaunch(userCodex());
  const back = JSON.parse(fs.readFileSync(path.join(codexSkills, SKILLS_STATE_NAME), 'utf8'));
  assert.equal(back.mode, undefined);
  assert.deepEqual(back.skills, ['delta', 'gamma']);
  assert.ok(fs.existsSync(path.join(store, 'mine', 'SKILL.md')));
});

test('Codex private read skips symlinks and refuses caps', () => {
  seedPrivateSkillsStore(userId, 'codex');
  const store = privateSkillsStoreRoot(userId, 'codex');
  fs.symlinkSync('/etc', path.join(store, 'gamma', 'etc'));
  const { files, skipped } = readPrivateSkillSources(userId, 'codex');
  assert.ok(skipped.includes('gamma/etc'));
  assert.ok([...files.keys()].every((rel) => !rel.includes('etc')));
  writeFile(path.join(store, 'gamma', 'huge.bin'), Buffer.alloc(1024 * 1024 + 1));
  assert.throws(() => readPrivateSkillSources(userId, 'codex'), PrivateStoreError);
  harnessFilesModeDb.setStoredMode(userId, 'private');
  assert.equal(materializeCodexSkillsForLaunch(userCodex()).reason, 'private_source_unavailable');
});

test('live scan reads CLAUDE_CONFIG_DIR from the process table only', () => {
  const proc = path.join(home, 'proc');
  const proc_ = (pid: string, comm: string, env: string) => {
    writeFile(path.join(proc, pid, 'environ'), env);
    writeFile(path.join(proc, pid, 'comm'), `${comm}\n`);
  };
  proc_('101', 'node', `PATH=/bin\0CLAUDE_CONFIG_DIR=${userClaude()}\0`);
  proc_('102', 'claude', 'CLAUDE_CONFIG_DIR=/elsewhere\0');
  proc_('103', 'bash', `CLAUDE_CONFIG_DIR=${userClaude()}\0`);
  proc_('104', 'tmux: server', `CLAUDE_CONFIG_DIR=${userClaude()}\0`);
  writeFile(path.join(proc, '105', 'environ'), `CLAUDE_CONFIG_DIR=${userClaude()}\0`);
  writeFile(path.join(proc, 'self', 'environ'), `CLAUDE_CONFIG_DIR=${userClaude()}\0`);
  assert.equal(scanLiveClaudeSessions(userClaude(), proc), true);
  fs.rmSync(path.join(proc, '101'), { recursive: true });
  assert.equal(scanLiveClaudeSessions(userClaude(), proc), false, 'shells/tmux/no-comm ignored');
  proc_('106', 'claude', `CLAUDE_CONFIG_DIR=${userClaude()}\0`);
  assert.equal(scanLiveClaudeSessions(userClaude(), proc), true);
  assert.equal(scanLiveClaudeSessions(userClaude(), path.join(home, 'no-proc')), true);
});
