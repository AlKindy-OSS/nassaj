/**
 * harness-files-c5-matrix.test — ADR-203 stage C5 rows that the C1–C3 suites
 * did not cover, on a real filesystem and a real database under a sandbox HOME:
 *   - flag values after the default flip (unset / 1 / 0 / other strings);
 *   - resolver fail-safes (unknown, inactive, invalid ids) and platform mode;
 *   - live-session deferral per launch kind through an injected process table
 *     (`claude -p`, managed terminal, SDK chat child), the comm filter, an
 *     unreadable process table and unreadable environ entries;
 *   - a symlink at EVERY store component, the per-user lock semantics, and the
 *     Codex private source never deleting unowned dirs or `.system`.
 * The process table is a fixture directory: no real process is inspected.
 */

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before, beforeEach } from 'node:test';

import {
  closeConnection,
  getConnection,
  harnessFilesModeDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';

import {
  describeClaudeSkillsLink,
  reconcileClaudeSkillsForEnv,
  reconcileClaudeSkillsLink,
  repointSymlink,
} from './claude-skills-link.js';
import { SKILLS_STATE_NAME } from './codex-shared-skills.js';
import { materializeCodexSkillsForLaunch } from './codex-skills-launch.js';
import {
  isHarnessFilesLockHeld,
  tryWithHarnessFilesLockSync,
  withHarnessFilesLock,
} from './harness-files-lock.js';
import {
  PRIVATE_SKILLS_DEFAULT_ENABLED,
  PRIVATE_SKILLS_FLAG,
  harnessFilesStateChanged,
  isPrivateSkillsFeatureEnabled,
  resolveHarnessFilesMode,
  resolveHarnessFilesState,
} from './harness-files-mode.js';
import {
  hasLiveClaudeSession,
  scanLiveClaudeSessions,
  setLiveClaudeSessionProbeForTest,
} from './live-claude-sessions.js';
import {
  PrivateStoreError,
  assertRealpathInside,
  listPrivateSkillFiles,
  privateSkillsStoreExists,
  privateSkillsStoreRoot,
  readPrivateSkillSources,
  resolvePrivateSkillTarget,
  seedPrivateSkillsStore,
} from './private-skills-store.js';

let home = '';
let dbDir = '';
let originalHome: string | undefined;
let ownerId = 0;
let memberId = 0;
let procRoot = '';

const skillMd = (name: string) => `---\nname: ${name}\ndescription: ${name} test\n---\n\nbody\n`;
const library = () => path.join(home, '.claude', 'skills');
const userClaude = (id: number) => path.join(home, '.nassaj-users', String(id), '.claude');
const userCodex = (id: number) => path.join(home, '.nassaj-users', String(id), '.codex');

function writeFile(target: string, body: string | Buffer): void {
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, body);
}

/** Adds one fixture process: `comm` plus a NUL-separated environ. */
function addProcess(pid: string, comm: string | null, env: Record<string, string>): void {
  const dir = path.join(procRoot, pid);
  fs.mkdirSync(dir, { recursive: true });
  if (comm !== null) fs.writeFileSync(path.join(dir, 'comm'), `${comm}\n`);
  const raw = Object.entries(env).map(([k, v]) => `${k}=${v}`).join('\0');
  fs.writeFileSync(path.join(dir, 'environ'), `${raw}\0`);
}

function provisionLink(id: number): string {
  fs.mkdirSync(userClaude(id), { recursive: true });
  const link = path.join(userClaude(id), 'skills');
  fs.symlinkSync(library(), link);
  return link;
}

function writeCore(): string {
  const core = path.join(home, 'core');
  const files: Record<string, string> = {
    'dist/portable/skills/gamma/SKILL.md': skillMd('gamma'),
  };
  const manifest: Record<string, { sha256: string; mode: string }> = {};
  for (const [rel, body] of Object.entries(files)) {
    writeFile(path.join(core, rel), body);
    manifest[rel] = { sha256: crypto.createHash('sha256').update(body).digest('hex'), mode: '0644' };
  }
  writeFile(path.join(core, 'dist', 'MANIFEST.json'), JSON.stringify({ files: manifest }));
  return core;
}

before(async () => {
  originalHome = process.env.HOME;
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-c5-db-'));
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  await initializeDatabase();
  const o = userDb.createUser('hf_c5_owner', 'hash', 'user') as { id: number };
  userDb.setRole(o.id, 'owner');
  ownerId = o.id;
  memberId = (userDb.createUser('hf_c5_member', 'hash', 'user') as { id: number }).id;
});

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-c5-home-'));
  process.env.HOME = home;
  procRoot = path.join(home, 'proc');
  fs.mkdirSync(procRoot);
  writeFile(path.join(library(), 'alpha', 'SKILL.md'), skillMd('alpha'));
  process.env.NASSAJ_CORE_DIR = writeCore();
  delete process.env[PRIVATE_SKILLS_FLAG];
  delete process.env.VITE_IS_PLATFORM;
  harnessFilesModeDb.setStoredMode(ownerId, 'shared');
  harnessFilesModeDb.setStoredMode(memberId, 'shared');
  harnessFilesModeDb.setAllowMemberPrivate(false);
  // Every reconcile below reads the FIXTURE process table, never the host's.
  setLiveClaudeSessionProbeForTest((dir) => scanLiveClaudeSessions(dir, procRoot));
});

afterEach(() => {
  setLiveClaudeSessionProbeForTest(null);
  fs.rmSync(home, { recursive: true, force: true });
  delete process.env.NASSAJ_CORE_DIR;
  delete process.env[PRIVATE_SKILLS_FLAG];
  delete process.env.VITE_IS_PLATFORM;
});

after(() => {
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
});

// ---- flag values -------------------------------------------------------------

test('flag: the shipped default is enabled; only an exact 0 is the kill switch', () => {
  assert.equal(PRIVATE_SKILLS_DEFAULT_ENABLED, true);
  const cases: [string | undefined, boolean][] = [
    [undefined, true], ['', true], ['1', true], [' 1 ', true], ['true', true],
    ['yes', true], ['0', false], [' 0\n', false], ['00', true], ['false', true],
  ];
  for (const [raw, expected] of cases) {
    const env: NodeJS.ProcessEnv = raw === undefined ? {} : { [PRIVATE_SKILLS_FLAG]: raw };
    assert.equal(isPrivateSkillsFeatureEnabled(env), expected, `flag=${JSON.stringify(raw)}`);
  }
});

test('flag unset: owner private takes effect; flag 0 reconciles the link back; unset restores', () => {
  const link = provisionLink(ownerId);
  harnessFilesModeDb.setStoredMode(ownerId, 'private');
  assert.equal(resolveHarnessFilesMode(ownerId), 'private');
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'repointed');
  assert.equal(fs.readlinkSync(link), privateSkillsStoreRoot(ownerId, 'claude'));
  process.env[PRIVATE_SKILLS_FLAG] = '0';
  assert.equal(describeClaudeSkillsLink(ownerId), 'pending');
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'repointed');
  assert.equal(fs.readlinkSync(link), library());
  assert.ok(fs.existsSync(path.join(privateSkillsStoreRoot(ownerId, 'claude'), 'alpha', 'SKILL.md')));
  delete process.env[PRIVATE_SKILLS_FLAG];
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'repointed');
  assert.equal(describeClaudeSkillsLink(ownerId), 'in-sync');
});

test('flag unset: members stay shared until the workspace switch is on', () => {
  harnessFilesModeDb.setStoredMode(memberId, 'private');
  const off = resolveHarnessFilesState(memberId);
  assert.equal(off.featureEnabled, true);
  assert.equal(off.canChoose, false);
  assert.equal(off.effective, 'shared');
  harnessFilesModeDb.setAllowMemberPrivate(true);
  assert.equal(resolveHarnessFilesMode(memberId), 'private');
  assert.equal(resolveHarnessFilesState(memberId).canChoose, true);
});

// ---- resolver fail-safes -----------------------------------------------------

test('resolver: invalid, unknown and inactive users answer shared', () => {
  for (const id of [null, undefined, '', 0, -1, 1.5, 'abc', 999999]) {
    assert.equal(resolveHarnessFilesMode(id as never), 'shared', `id=${String(id)}`);
  }
  const temp = (userDb.createUser('hf_c5_inactive', 'hash', 'user') as { id: number }).id;
  userDb.setRole(temp, 'owner');
  harnessFilesModeDb.setStoredMode(temp, 'private');
  assert.equal(resolveHarnessFilesMode(temp), 'private');
  getConnection().prepare('UPDATE users SET is_active = 0 WHERE id = ?').run(temp);
  const state = resolveHarnessFilesState(temp);
  assert.equal(state.role, null);
  assert.equal(state.effective, 'shared');
  assert.equal(state.canChoose, false);
});

test('resolver: platform mode answers shared and offers no choice', () => {
  harnessFilesModeDb.setStoredMode(ownerId, 'private');
  process.env.VITE_IS_PLATFORM = 'true';
  assert.equal(resolveHarnessFilesMode(ownerId), 'shared');
  const state = resolveHarnessFilesState(ownerId);
  assert.equal(state.platformMode, true);
  assert.equal(state.canChoose, false);
  assert.equal(state.requested, 'private');
});

test('harnessFilesStateChanged flags effective, requested and canChoose changes only', () => {
  const base = resolveHarnessFilesState(ownerId);
  assert.equal(harnessFilesStateChanged(base, { ...base }), false);
  assert.equal(harnessFilesStateChanged(base, { ...base, effective: 'private' }), true);
  assert.equal(harnessFilesStateChanged(base, { ...base, requested: 'private' }), true);
  assert.equal(harnessFilesStateChanged(base, { ...base, canChoose: !base.canChoose }), true);
  assert.equal(harnessFilesStateChanged(base, { ...base, allowMemberPrivate: true }), false);
});

// ---- live sessions, one row per launch kind -----------------------------------

function liveDeferralCase(arrange: () => void): { status: string; link: string } {
  const link = provisionLink(ownerId);
  harnessFilesModeDb.setStoredMode(ownerId, 'private');
  arrange();
  return { status: reconcileClaudeSkillsLink(ownerId), link };
}

test('live: a `claude -p` run carrying the user CLAUDE_CONFIG_DIR defers the repoint', () => {
  const { status, link } = liveDeferralCase(() => {
    addProcess('4101', 'claude', { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: userClaude(ownerId) });
  });
  assert.equal(status, 'deferred-live-session');
  assert.equal(fs.readlinkSync(link), library());
  assert.equal(describeClaudeSkillsLink(ownerId), 'pending');
  fs.rmSync(path.join(procRoot, '4101'), { recursive: true });
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'repointed', 'next launch applies it');
});

test('live: a managed terminal (shell + claude child) defers; the shell alone does not', () => {
  const { status, link } = liveDeferralCase(() => {
    addProcess('4201', 'bash', { CLAUDE_CONFIG_DIR: userClaude(ownerId), TERM: 'xterm-256color' });
    addProcess('4202', 'claude', { CLAUDE_CONFIG_DIR: userClaude(ownerId), TERM: 'xterm-256color' });
  });
  assert.equal(status, 'deferred-live-session');
  assert.equal(fs.readlinkSync(link), library());
  fs.rmSync(path.join(procRoot, '4202'), { recursive: true });
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'repointed', 'idle terminal shell does not block');
});

test('live: an SDK chat child (node) defers; launch-path reconcile goes through the env', () => {
  const { status } = liveDeferralCase(() => {
    addProcess('4301', 'node', { CLAUDE_CONFIG_DIR: `${userClaude(ownerId)}/` });
  });
  assert.equal(status, 'deferred-live-session', 'trailing slash is the same dir');
  assert.equal(reconcileClaudeSkillsForEnv({ CLAUDE_CONFIG_DIR: userClaude(ownerId) }), 'deferred-live-session');
});

test('live: a config dir reached through a symlink alias is the same session', () => {
  const alias = path.join(home, 'alias-claude');
  const { status } = liveDeferralCase(() => {
    fs.symlinkSync(userClaude(ownerId), alias);
    addProcess('4401', 'claude', { CLAUDE_CONFIG_DIR: alias });
  });
  assert.equal(status, 'deferred-live-session');
});

test('comm filter: bash, tmux, sh and missing comm are ignored; other users do not block', () => {
  const { status, link } = liveDeferralCase(() => {
    addProcess('4501', 'bash', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
    addProcess('4502', 'tmux: server', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
    addProcess('4503', 'sh', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
    addProcess('4504', null, { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
    addProcess('4505', 'claude', { CLAUDE_CONFIG_DIR: userClaude(memberId) });
    addProcess('4506', 'claude', { CLAUDE_CONFIG_DIRX: userClaude(ownerId) });
    addProcess(String(process.pid), 'node', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
    writeFile(path.join(procRoot, 'self', 'environ'), `CLAUDE_CONFIG_DIR=${userClaude(ownerId)}\0`);
  });
  assert.equal(status, 'repointed');
  assert.equal(fs.readlinkSync(link), privateSkillsStoreRoot(ownerId, 'claude'));
});

test('unreadable process table → treated as live: deferred, link unchanged', () => {
  const missing = path.join(home, 'no-proc');
  setLiveClaudeSessionProbeForTest((dir) => scanLiveClaudeSessions(dir, missing));
  const { status, link } = liveDeferralCase(() => {});
  assert.equal(status, 'deferred-live-session');
  assert.equal(fs.readlinkSync(link), library());
  assert.equal(scanLiveClaudeSessions(userClaude(ownerId), path.join(home, 'not-a-dir.txt')), true);
});

test('an unreadable environ entry (another uid) is skipped, not counted as live', { skip: process.getuid?.() === 0 }, () => {
  addProcess('4601', 'claude', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
  fs.chmodSync(path.join(procRoot, '4601', 'environ'), 0o000);
  try {
    assert.equal(scanLiveClaudeSessions(userClaude(ownerId), procRoot), false);
  } finally {
    fs.chmodSync(path.join(procRoot, '4601', 'environ'), 0o600);
  }
});

test('the default probe scans the host process table without throwing', () => {
  setLiveClaudeSessionProbeForTest(null);
  const unique = path.join(home, `never-used-${crypto.randomBytes(4).toString('hex')}`);
  assert.equal(typeof hasLiveClaudeSession(unique), 'boolean');
});

test('a native CLI whose comm is its version string defers the repoint (exe path)', () => {
  // A native install exec-ed by its real path (…/claude/versions/<ver>) has
  // comm = "<ver>", not "claude"; observed on this host for a live CLI process.
  const { status, link } = liveDeferralCase(() => {
    addProcess('4701', '2.1.283', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
    fs.symlinkSync('/opt/fixture/.local/share/claude/versions/2.1.283', path.join(procRoot, '4701', 'exe'));
  });
  assert.equal(status, 'deferred-live-session');
  assert.equal(fs.readlinkSync(link), library());
});

test('exe basename claude/node counts even when comm does not; a shell exe does not', () => {
  addProcess('4801', 'MainThread', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
  fs.symlinkSync('/opt/fixture/bin/node (deleted)', path.join(procRoot, '4801', 'exe'));
  assert.equal(scanLiveClaudeSessions(userClaude(ownerId), procRoot), true);
  fs.rmSync(path.join(procRoot, '4801'), { recursive: true });
  addProcess('4802', 'worker', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
  fs.symlinkSync('/opt/fixture/bin/claude', path.join(procRoot, '4802', 'exe'));
  assert.equal(scanLiveClaudeSessions(userClaude(ownerId), procRoot), true);
  fs.rmSync(path.join(procRoot, '4802'), { recursive: true });
  addProcess('4803', 'bash', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
  fs.symlinkSync('/usr/bin/bash', path.join(procRoot, '4803', 'exe'));
  addProcess('4804', '2.1.283', { CLAUDE_CONFIG_DIR: userClaude(ownerId) });
  assert.equal(scanLiveClaudeSessions(userClaude(ownerId), procRoot), false, 'shell exe and exe-less version comm ignored');
  fs.rmSync(path.join(procRoot, '4803'), { recursive: true });
  fs.rmSync(path.join(procRoot, '4804'), { recursive: true });
});

// ---- store path spoofing at every component ------------------------------------

test('a symlink at ANY store component is refused and nothing is written through it', () => {
  const userRoot = path.join(home, '.nassaj-users', String(ownerId));
  const components = [
    path.join(home, '.nassaj-users'),
    userRoot,
    path.join(userRoot, '.nassaj-private'),
    path.join(userRoot, '.nassaj-private', 'claude'),
    path.join(userRoot, '.nassaj-private', 'claude', 'skills'),
  ];
  for (const component of components) {
    fs.rmSync(path.join(home, '.nassaj-users'), { recursive: true, force: true });
    const outside = fs.mkdtempSync(path.join(home, 'outside-'));
    fs.mkdirSync(path.dirname(component), { recursive: true });
    fs.symlinkSync(outside, component);
    const label = path.relative(home, component);
    assert.throws(() => seedPrivateSkillsStore(ownerId, 'claude'),
      (err: unknown) => err instanceof PrivateStoreError && err.code === 'path_rejected', label);
    assert.throws(() => resolvePrivateSkillTarget(ownerId, 'claude', 'alpha'), PrivateStoreError, label);
    assert.throws(() => privateSkillsStoreExists(ownerId, 'claude'), PrivateStoreError, label);
    assert.throws(() => readPrivateSkillSources(ownerId, 'claude'), PrivateStoreError, label);
    assert.deepEqual(listPrivateSkillFiles(ownerId, 'claude'), [], label);
    assert.deepEqual(fs.readdirSync(outside), [], `nothing written through ${label}`);
  }
});

test('a regular file in place of a store component is refused', () => {
  const userRoot = path.join(home, '.nassaj-users', String(ownerId));
  writeFile(path.join(userRoot, '.nassaj-private'), 'not a dir');
  assert.throws(() => seedPrivateSkillsStore(ownerId, 'claude'),
    (err: unknown) => err instanceof PrivateStoreError && err.code === 'path_rejected');
});

test('unsafe skill names and ids are refused; realpath containment holds', () => {
  for (const name of ['..', '.', '../x', '..%2F', '.nassaj-skill.json', 'a b/c', 'x\0y', 42]) {
    assert.throws(() => resolvePrivateSkillTarget(ownerId, 'claude', name as string), PrivateStoreError, String(name));
  }
  for (const id of ['0', '-1', '1e3', ' 2x', '../1']) {
    assert.throws(() => privateSkillsStoreRoot(id, 'claude'), PrivateStoreError, id);
  }
  const store = path.dirname(resolvePrivateSkillTarget(ownerId, 'claude', 'fine'));
  assert.throws(() => assertRealpathInside(path.join(home, 'elsewhere'), store), PrivateStoreError);
  fs.mkdirSync(path.join(home, 'elsewhere'));
  assert.throws(() => assertRealpathInside(path.join(home, 'elsewhere'), store), PrivateStoreError);
  assert.doesNotThrow(() => assertRealpathInside(path.join(store, 'new-skill'), store));
});

test('listing skips unsafe names, symlinks and folders without a real SKILL.md', () => {
  seedPrivateSkillsStore(ownerId, 'claude');
  const store = privateSkillsStoreRoot(ownerId, 'claude');
  fs.mkdirSync(path.join(store, 'nodoc'));
  fs.symlinkSync(path.join(store, 'alpha'), path.join(store, 'alias'));
  fs.mkdirSync(path.join(store, 'linked-md'));
  fs.symlinkSync(path.join(store, 'alpha', 'SKILL.md'), path.join(store, 'linked-md', 'SKILL.md'));
  writeFile(path.join(store, '.hidden', 'SKILL.md'), skillMd('hidden'));
  assert.deepEqual(listPrivateSkillFiles(ownerId, 'claude'), [path.join(store, 'alpha', 'SKILL.md')]);
  assert.deepEqual(listPrivateSkillFiles('nope', 'claude'), []);
});

// ---- repoint primitives ----------------------------------------------------------

test('repointSymlink: missing target, create, unchanged, repoint; no temp debris', () => {
  const dir = path.join(home, 'rp');
  fs.mkdirSync(dir);
  const a = path.join(dir, 'a');
  const b = path.join(dir, 'b');
  fs.mkdirSync(a);
  fs.mkdirSync(b);
  const link = path.join(dir, 'skills');
  assert.equal(repointSymlink(link, path.join(dir, 'absent')), 'missing-target');
  assert.equal(repointSymlink(link, a), 'created');
  assert.equal(repointSymlink(link, a), 'unchanged');
  assert.equal(repointSymlink(link, b), 'repointed');
  assert.equal(fs.readlinkSync(link), b);
  assert.deepEqual(fs.readdirSync(dir).sort(), ['a', 'b', 'skills']);
});

test('reconcile without a user config dir reports not-a-user-home; describe absent', () => {
  harnessFilesModeDb.setStoredMode(ownerId, 'private');
  assert.equal(describeClaudeSkillsLink(ownerId), 'absent');
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'not-a-user-home');
  assert.equal(reconcileClaudeSkillsLink('x'), 'not-a-user-home');
  assert.equal(reconcileClaudeSkillsLink(0), 'not-a-user-home');
});

test('a private store that cannot be prepared keeps the current link', () => {
  const link = provisionLink(ownerId);
  harnessFilesModeDb.setStoredMode(ownerId, 'private');
  const outside = path.join(home, 'outside-store');
  fs.mkdirSync(outside);
  fs.symlinkSync(outside, path.join(home, '.nassaj-users', String(ownerId), '.nassaj-private'));
  assert.equal(reconcileClaudeSkillsLink(ownerId), 'private-store-unavailable');
  assert.equal(fs.readlinkSync(link), library());
});

// ---- per-user lock ---------------------------------------------------------------

test('lock: FIFO per user, independent across users, released after a throw', async () => {
  const order: string[] = [];
  let releaseFirst: () => void = () => {};
  const first = withHarnessFilesLock(ownerId, async () => {
    order.push('first:start');
    await new Promise<void>((resolve) => { releaseFirst = resolve; });
    order.push('first:end');
  });
  const second = withHarnessFilesLock(ownerId, () => { order.push('second'); });
  await withHarnessFilesLock(memberId, () => { order.push('other-user'); });
  assert.equal(isHarnessFilesLockHeld(ownerId), true);
  assert.deepEqual(tryWithHarnessFilesLockSync(ownerId, () => 1), { ran: false });
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(order, ['first:start', 'other-user', 'first:end', 'second']);
  assert.equal(isHarnessFilesLockHeld(ownerId), false);
  await assert.rejects(withHarnessFilesLock(ownerId, () => { throw new Error('boom'); }), /boom/);
  assert.equal(isHarnessFilesLockHeld(ownerId), false);
  assert.throws(() => tryWithHarnessFilesLockSync(ownerId, () => { throw new Error('sync'); }), /sync/);
  assert.deepEqual(tryWithHarnessFilesLockSync(ownerId, () => 7), { ran: true, value: 7 });
});

// ---- Codex private source ----------------------------------------------------------

test('Codex private: unowned dirs and .system survive both directions; no owner = shared', () => {
  const codexSkills = path.join(userCodex(ownerId), 'skills');
  writeFile(path.join(codexSkills, 'hand-made', 'SKILL.md'), skillMd('hand-made'));
  writeFile(path.join(codexSkills, '.system', 'sys', 'SKILL.md'), skillMd('sys'));
  harnessFilesModeDb.setStoredMode(ownerId, 'private');
  assert.equal(materializeCodexSkillsForLaunch(userCodex(ownerId)).ok, true);
  const state = JSON.parse(fs.readFileSync(path.join(codexSkills, SKILLS_STATE_NAME), 'utf8'));
  assert.equal(state.mode, 'private');
  process.env[PRIVATE_SKILLS_FLAG] = '0';
  assert.equal(materializeCodexSkillsForLaunch(userCodex(ownerId)).ok, true);
  assert.ok(fs.existsSync(path.join(codexSkills, 'hand-made', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexSkills, '.system', 'sys', 'SKILL.md')));
  assert.ok(fs.existsSync(path.join(codexSkills, 'gamma', 'SKILL.md')));
  const operatorHome = path.join(home, '.codex');
  assert.equal(materializeCodexSkillsForLaunch(operatorHome).ok, true);
});
