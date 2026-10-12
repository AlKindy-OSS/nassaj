/**
 * harness-files.routes.test — the wire contract and authorization rules of the
 * shared/private skills switch (ADR-203, T-2003 C1), against a REAL database
 * built by the real migrations, under a sandbox HOME.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, afterEach, before } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  auditLogDb,
  closeConnection,
  getConnection,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import {
  PRIVATE_SKILLS_FLAG,
  resolveHarnessFilesMode,
  resolveHarnessFilesState,
} from '@/services/isolation/harness-files-mode.js';
import { withHarnessFilesLock } from '@/services/isolation/harness-files-lock.js';
import { setLiveClaudeSessionProbeForTest } from '@/services/isolation/live-claude-sessions.js';
import { privateSkillsStoreRoot } from '@/services/isolation/private-skills-store.js';
import { AppError } from '@/shared/utils.js';

import { harnessFilesRoutes } from './index.js';

type TestUser = { id: number; role: string };
type Json = Record<string, any>;

let currentUser: TestUser | null = null;
let server: Server;
let baseUrl = '';
let dbDir = '';
let sandboxHome = '';
let originalHome: string | undefined;
let member: TestUser;
let member2: TestUser;
let owner: TestUser;
let admin: TestUser;

async function call(method: string, urlPath: string, user: TestUser | null, body?: unknown) {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/harness-files${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const json = (await response.json().catch(() => ({}))) as Json;
  return { status: response.status, json };
}

const modeRows = () => getConnection()
  .prepare('SELECT user_id, mode FROM user_harness_files_mode ORDER BY user_id').all() as
  { user_id: number; mode: string }[];

const auditRows = (action: string) => getConnection()
  .prepare('SELECT user_id, metadata FROM audit_log WHERE action = ? ORDER BY id').all(action) as
  { user_id: number; metadata: string }[];

function resetState(): void {
  getConnection().prepare('DELETE FROM user_harness_files_mode').run();
  getConnection().prepare("DELETE FROM app_config WHERE key LIKE 'harness_files.%'").run();
  getConnection().prepare("DELETE FROM audit_log WHERE action LIKE 'harness_files_%'").run();
  fs.rmSync(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
}

before(async () => {
  closeConnection();
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-routes-db-'));
  sandboxHome = fs.mkdtempSync(path.join(os.tmpdir(), 'hf-routes-home-'));
  originalHome = process.env.HOME;
  process.env.HOME = sandboxHome;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  delete process.env.VITE_IS_PLATFORM;
  // A core root without a manifest: the Codex seed is empty, as in shared mode.
  process.env.NASSAJ_CORE_DIR = path.join(sandboxHome, 'core');
  fs.mkdirSync(process.env.NASSAJ_CORE_DIR, { recursive: true });
  await initializeDatabase();

  const make = (name: string, role: 'owner' | 'admin' | 'user'): TestUser => {
    const created = userDb.createUser(name, 'hash', 'user') as { id: number };
    if (role !== 'user') userDb.setRole(created.id, role);
    return { id: created.id, role };
  };
  member = make('hf_member', 'user');
  member2 = make('hf_member_two', 'user');
  owner = make('hf_owner', 'owner');
  admin = make('hf_admin', 'admin');

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: TestUser | null }).user = currentUser;
    next();
  });
  app.use('/api/harness-files', harnessFilesRoutes);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: 'internal' });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  resetState();
  delete process.env[PRIVATE_SKILLS_FLAG];
  delete process.env.VITE_IS_PLATFORM;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(dbDir, { recursive: true, force: true });
  fs.rmSync(sandboxHome, { recursive: true, force: true });
});

test('GET returns the contract; the member never sees the member count', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const asMember = await call('GET', '/', member);
  assert.equal(asMember.status, 200);
  assert.deepEqual(asMember.json.workspace, { allowMemberPrivate: false });
  assert.equal(asMember.json.me.requested, 'shared');
  assert.equal(asMember.json.me.effective, 'shared');
  assert.equal(asMember.json.me.canChoose, false);
  assert.equal(asMember.json.me.canManageWorkspace, false);
  const support = asMember.json.me.harnesses as { provider: string; support: string; reason?: string }[];
  assert.deepEqual(support.filter((h) => h.support === 'full').map((h) => h.provider), ['claude', 'codex']);
  assert.ok(support.filter((h) => h.support === 'shared-only').every((h) => typeof h.reason === 'string'));

  const asOwner = await call('GET', '/', owner);
  assert.equal(asOwner.json.workspace.savedPrivateMembers, 0);
  assert.equal(asOwner.json.me.canChoose, true);
  assert.equal(asOwner.json.me.canManageWorkspace, true);
});

test('flag unset (shipped default): enabled; owner may go private, members stay OFF', async () => {
  const asMember = await call('GET', '/', member);
  assert.equal(asMember.json.me.featureEnabled, true);
  assert.equal(asMember.json.me.canChoose, false);
  assert.equal(asMember.json.workspace.allowMemberPrivate, false);
  const denied = await call('PUT', '/me', member, { mode: 'private' });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'HARNESS_FILES_PRIVATE_DISABLED');
  assert.equal((await call('PUT', '/me', owner, { mode: 'private' })).status, 200);
  assert.equal(resolveHarnessFilesMode(owner.id), 'private');
  assert.deepEqual(modeRows(), [{ user_id: owner.id, mode: 'private' }]);
});

test('flag 0 (kill switch) refuses private with FEATURE_DISABLED and writes nothing', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '0';
  const res = await call('PUT', '/me', owner, { mode: 'private' });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'HARNESS_FILES_FEATURE_DISABLED');
  assert.deepEqual(modeRows(), []);
  assert.equal(resolveHarnessFilesMode(owner.id), 'shared');
  assert.equal((await call('GET', '/', owner)).json.me.featureEnabled, false);
});

test('flag 0 forces shared even with a stored private choice; 1 enables it', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  assert.equal((await call('PUT', '/me', owner, { mode: 'private' })).status, 200);
  assert.equal(resolveHarnessFilesMode(owner.id), 'private');
  process.env[PRIVATE_SKILLS_FLAG] = '0';
  assert.equal(resolveHarnessFilesMode(owner.id), 'shared');
  assert.equal(resolveHarnessFilesState(owner.id).requested, 'private');
});

test('member asking private while the workspace switch is OFF gets 403 and no row', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const res = await call('PUT', '/me', member, { mode: 'private' });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'HARNESS_FILES_PRIVATE_DISABLED');
  assert.deepEqual(modeRows(), []);
  assert.deepEqual(auditRows('harness_files_mode_changed'), []);
});

test('a userId in the body is ignored: only the caller row changes', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  assert.equal((await call('PUT', '/workspace', owner, { allowMemberPrivate: true })).status, 200);
  const res = await call('PUT', '/me', member, { mode: 'private', userId: owner.id });
  assert.equal(res.status, 200);
  assert.deepEqual(modeRows(), [{ user_id: member.id, mode: 'private' }]);
  assert.equal(resolveHarnessFilesState(owner.id).requested, 'shared');
});

test('PUT /workspace: member 403, admin and owner allowed, strict audit written', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const denied = await call('PUT', '/workspace', member, { allowMemberPrivate: true });
  assert.equal(denied.status, 403);
  assert.equal(denied.json.code, 'HARNESS_FILES_WORKSPACE_FORBIDDEN');
  assert.equal((await call('PUT', '/workspace', admin, { allowMemberPrivate: true })).status, 200);
  assert.equal((await call('PUT', '/workspace', owner, { allowMemberPrivate: false })).status, 200);
  const rows = auditRows('harness_files_member_policy_changed');
  assert.equal(rows.length, 2);
  assert.deepEqual(JSON.parse(rows[0].metadata), { from: false, to: true, role: 'admin', affectedMembers: 0 });
  assert.equal(rows[1].user_id, owner.id);
  assert.equal((await call('PUT', '/workspace', owner, { allowMemberPrivate: 'yes' })).status, 400);
});

test('platform mode: both PUTs 403 and the resolver answers shared', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  assert.equal((await call('PUT', '/me', owner, { mode: 'private' })).status, 200);
  process.env.VITE_IS_PLATFORM = 'true';
  assert.equal(resolveHarnessFilesMode(owner.id), 'shared');
  const me = await call('PUT', '/me', owner, { mode: 'shared' });
  assert.equal(me.status, 403);
  assert.equal(me.json.code, 'HARNESS_FILES_PLATFORM');
  const ws = await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
  assert.equal(ws.status, 403);
  assert.equal(ws.json.code, 'HARNESS_FILES_PLATFORM');
});

test('switch re-enabled: members return to their saved choice; count is shown first', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
  assert.equal((await call('PUT', '/me', member, { mode: 'private' })).status, 200);
  assert.equal(resolveHarnessFilesMode(member.id), 'private');
  const off = await call('PUT', '/workspace', admin, { allowMemberPrivate: false });
  assert.equal(off.json.affectedMembers, 1);
  assert.equal(resolveHarnessFilesMode(member.id), 'shared');
  assert.equal(resolveHarnessFilesState(member.id).requested, 'private');
  const preview = await call('GET', '/', owner);
  assert.equal(preview.json.workspace.savedPrivateMembers, 1);
  const on = await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
  assert.equal(on.json.affectedMembers, 1);
  assert.equal(resolveHarnessFilesMode(member.id), 'private');
  assert.equal(resolveHarnessFilesMode(member2.id), 'shared');
});

test('a failed strict audit rolls the mode row back', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const original = auditLogDb.recordStrict;
  auditLogDb.recordStrict = () => { throw new Error('audit down'); };
  try {
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 500);
    const ws = await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
    assert.equal(ws.status, 500);
  } finally {
    auditLogDb.recordStrict = original;
  }
  assert.deepEqual(modeRows(), []);
  assert.equal(resolveHarnessFilesState(owner.id).allowMemberPrivate, false);
});

test('switch turned off while the request waits for the lock → 409, nothing written', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
  let release: () => void = () => {};
  const held = withHarnessFilesLock(member.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const pending = call('PUT', '/me', member, { mode: 'private' });
  await new Promise((resolve) => setTimeout(resolve, 50));
  await call('PUT', '/workspace', owner, { allowMemberPrivate: false });
  release();
  await held;
  const res = await pending;
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'HARNESS_FILES_MODE_CHANGED');
  assert.deepEqual(modeRows(), []);
});

test('mode audit carries from/to/effective/role and the row cascades on user delete', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  await call('PUT', '/me', admin, { mode: 'private' });
  const rows = auditRows('harness_files_mode_changed');
  assert.deepEqual(JSON.parse(rows[0].metadata), { from: 'shared', to: 'private', effective: 'private', role: 'admin' });
  const temp = userDb.createUser('hf_temp', 'hash', 'user') as { id: number };
  userDb.setRole(temp.id, 'admin');
  await call('PUT', '/me', { id: temp.id, role: 'admin' }, { mode: 'private' });
  getConnection().prepare('DELETE FROM users WHERE id = ?').run(temp.id);
  assert.equal(modeRows().some((row) => row.user_id === temp.id), false);
});

function claudeFixture(user: TestUser): string {
  const library = path.join(sandboxHome, '.claude', 'skills');
  fs.mkdirSync(path.join(library, 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(library, 'alpha', 'SKILL.md'), '---\nname: alpha\ndescription: a\n---\n');
  const configDir = path.join(sandboxHome, '.nassaj-users', String(user.id), '.claude');
  fs.mkdirSync(configDir, { recursive: true });
  const link = path.join(configDir, 'skills');
  fs.rmSync(link, { force: true });
  fs.symlinkSync(library, link);
  return link;
}

test('PUT /me private seeds the stores first, then repoints the Claude link', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  setLiveClaudeSessionProbeForTest(() => false);
  try {
    const link = claudeFixture(owner);
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 200);
    assert.equal(res.json.claudeLink, 'repointed');
    assert.equal(res.json.me.claude.link, 'in-sync');
    assert.equal(fs.readlinkSync(link), privateSkillsStoreRoot(owner.id, 'claude'));
    assert.ok(fs.existsSync(path.join(privateSkillsStoreRoot(owner.id, 'claude'), 'alpha', 'SKILL.md')));
    assert.ok(fs.lstatSync(privateSkillsStoreRoot(owner.id, 'codex')).isDirectory());
    const back = await call('PUT', '/me', owner, { mode: 'shared' });
    assert.equal(back.json.claudeLink, 'repointed');
    assert.ok(fs.existsSync(path.join(privateSkillsStoreRoot(owner.id, 'claude'), 'alpha', 'SKILL.md')));
  } finally {
    setLiveClaudeSessionProbeForTest(null);
    fs.rmSync(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
  }
});

test('a live session defers the repoint and the view reports pending', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  setLiveClaudeSessionProbeForTest(() => true);
  try {
    claudeFixture(admin);
    const res = await call('PUT', '/me', admin, { mode: 'private' });
    assert.equal(res.json.claudeLink, 'deferred-live-session');
    assert.equal(res.json.me.claude.link, 'pending');
  } finally {
    setLiveClaudeSessionProbeForTest(null);
    fs.rmSync(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
  }
});

test('a seed over the caps fails the switch with 422 and writes no row', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const big = path.join(sandboxHome, '.claude', 'skills', 'alpha', 'big.bin');
  try {
    claudeFixture(owner);
    fs.writeFileSync(big, Buffer.alloc(1024 * 1024 + 1));
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 422);
    assert.equal(res.json.code, 'HARNESS_FILES_SEED_TOO_LARGE');
    assert.deepEqual(modeRows(), []);
    assert.deepEqual(auditRows('harness_files_mode_changed'), []);
  } finally {
    fs.rmSync(big, { force: true });
    fs.rmSync(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
  }
});

test('missing nassaj-core root → 503 and no row', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const core = process.env.NASSAJ_CORE_DIR;
  delete process.env.NASSAJ_CORE_DIR;
  try {
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 503);
    assert.equal(res.json.code, 'HARNESS_FILES_SEED_SOURCE_UNAVAILABLE');
    assert.deepEqual(modeRows(), []);
  } finally {
    process.env.NASSAJ_CORE_DIR = core;
  }
});

test('an unclassified fs failure answers a generic 500 without any path', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  const userRoot = path.join(sandboxHome, '.nassaj-users', String(owner.id));
  fs.mkdirSync(userRoot, { recursive: true });
  fs.chmodSync(userRoot, 0o500);
  try {
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 500);
    assert.equal(res.json.code, 'HARNESS_FILES_STORE_FAILED');
    assert.equal(JSON.stringify(res.json).includes(sandboxHome), false);
    assert.equal(JSON.stringify(res.json).includes('/'), false);
    assert.deepEqual(modeRows(), []);
  } finally {
    fs.chmodSync(userRoot, 0o700);
  }
});

// ---- ADR-203 C5 test matrix (rows not covered above) -------------------------

test('no route changes another user: target-id paths 404, body userId ignored on /workspace', async () => {
  assert.equal((await call('PUT', `/me/${member.id}`, owner, { mode: 'private' })).status, 404);
  assert.equal((await call('PUT', `/${member.id}`, owner, { mode: 'private' })).status, 404);
  assert.equal((await call('PUT', `/users/${member.id}`, owner, { mode: 'private' })).status, 404);
  assert.deepEqual(modeRows(), []);
  const ws = await call('PUT', '/workspace', admin, { allowMemberPrivate: true, userId: owner.id, role: 'owner' });
  assert.equal(ws.status, 200);
  const rows = auditRows('harness_files_member_policy_changed');
  assert.equal(rows[0].user_id, admin.id);
  assert.equal(JSON.parse(rows[0].metadata).role, 'admin');
  const spoof = await call('PUT', '/me', member, { mode: 'private', role: 'owner' });
  assert.equal(spoof.status, 200, 'switch is on, so the member may choose; body role ignored');
  const audit = auditRows('harness_files_mode_changed');
  assert.equal(JSON.parse(audit[0].metadata).role, 'user');
});

test('a body role cannot lift a member over the workspace switch', async () => {
  const res = await call('PUT', '/workspace', member, { allowMemberPrivate: true, role: 'owner' });
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'HARNESS_FILES_WORKSPACE_FORBIDDEN');
  assert.equal(resolveHarnessFilesState(member.id).allowMemberPrivate, false);
});

test('an unauthenticated caller is refused on both PUTs; invalid bodies are 400', async () => {
  const me = await call('PUT', '/me', null, { mode: 'private' });
  assert.equal(me.status, 403);
  assert.equal(me.json.code, 'HARNESS_FILES_UNIDENTIFIED');
  const ws = await call('PUT', '/workspace', null, { allowMemberPrivate: true });
  assert.equal(ws.status, 403);
  for (const body of [{}, { mode: 'PRIVATE' }, { mode: 1 }, { mode: null }]) {
    const res = await call('PUT', '/me', owner, body);
    assert.equal(res.status, 400);
    assert.equal(res.json.code, 'HARNESS_FILES_MODE_INVALID');
  }
  assert.deepEqual(modeRows(), []);
});

test('platform mode: GET offers no choice and no workspace control; member resolver shared', async () => {
  await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
  assert.equal((await call('PUT', '/me', member, { mode: 'private' })).status, 200);
  process.env.VITE_IS_PLATFORM = 'true';
  const asOwner = await call('GET', '/', owner);
  assert.equal(asOwner.json.me.canChoose, false);
  assert.equal(asOwner.json.me.canManageWorkspace, false);
  assert.equal('savedPrivateMembers' in asOwner.json.workspace, false);
  assert.equal(resolveHarnessFilesMode(member.id), 'shared');
  assert.equal(resolveHarnessFilesState(member.id).requested, 'private', 'saved choice kept');
  const back = await call('PUT', '/me', member, { mode: 'shared' });
  assert.equal(back.json.code, 'HARNESS_FILES_PLATFORM');
});

test('re-enable count covers only members with a saved private choice', async () => {
  await call('PUT', '/workspace', owner, { allowMemberPrivate: true });
  await call('PUT', '/me', member, { mode: 'private' });
  await call('PUT', '/me', member2, { mode: 'private' });
  await call('PUT', '/me', admin, { mode: 'private' });
  await call('PUT', '/me', member2, { mode: 'shared' });
  const off = await call('PUT', '/workspace', owner, { allowMemberPrivate: false });
  assert.equal(off.json.affectedMembers, 1);
  assert.equal(resolveHarnessFilesMode(admin.id), 'private', 'admin unaffected by the switch');
  assert.equal((await call('GET', '/', admin)).json.workspace.savedPrivateMembers, 1);
  const again = await call('PUT', '/workspace', owner, { allowMemberPrivate: false });
  assert.equal(again.json.affectedMembers, 0, 'no-op switch reports nothing');
  assert.equal(auditRows('harness_files_member_policy_changed').length, 2);
  const on = await call('PUT', '/workspace', admin, { allowMemberPrivate: true });
  assert.equal(on.json.affectedMembers, 1);
  assert.equal(JSON.parse(auditRows('harness_files_member_policy_changed')[2].metadata).affectedMembers, 1);
  assert.equal(resolveHarnessFilesMode(member.id), 'private');
  assert.equal(resolveHarnessFilesMode(member2.id), 'shared');
});

test('re-sending the current mode is a no-op: no audit row, claudeLink unchanged', async () => {
  const res = await call('PUT', '/me', owner, { mode: 'shared' });
  assert.equal(res.status, 200);
  assert.equal(res.json.claudeLink, 'unchanged');
  assert.deepEqual(auditRows('harness_files_mode_changed'), []);
});

test('legacy real .claude/skills dir and skills.bak-* siblings stay untouched through the API', async () => {
  setLiveClaudeSessionProbeForTest(() => false);
  try {
    const configDir = path.join(sandboxHome, '.nassaj-users', String(owner.id), '.claude');
    fs.mkdirSync(path.join(configDir, 'skills', 'legacy-skill'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'skills', 'legacy-skill', 'SKILL.md'), 'legacy');
    fs.mkdirSync(path.join(configDir, 'skills.bak-0510', 'old'), { recursive: true });
    fs.writeFileSync(path.join(configDir, 'skills.bak-0510', 'old', 'SKILL.md'), 'old');
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 200);
    assert.equal(res.json.claudeLink, 'legacy-real-dir');
    assert.equal(res.json.me.claude.link, 'legacy-real-dir');
    assert.equal((await call('PUT', '/me', owner, { mode: 'shared' })).json.claudeLink, 'legacy-real-dir');
    assert.ok(fs.lstatSync(path.join(configDir, 'skills')).isDirectory());
    assert.deepEqual(fs.readdirSync(path.join(configDir, 'skills')), ['legacy-skill']);
    assert.equal(fs.readFileSync(path.join(configDir, 'skills', 'legacy-skill', 'SKILL.md'), 'utf8'), 'legacy');
    assert.deepEqual(fs.readdirSync(path.join(configDir, 'skills.bak-0510')), ['old']);
    assert.equal(fs.readFileSync(path.join(configDir, 'skills.bak-0510', 'old', 'SKILL.md'), 'utf8'), 'old');
  } finally {
    setLiveClaudeSessionProbeForTest(null);
  }
});

test('caps over the API: too many files or too deep a tree → 422, no row, no store', async () => {
  const library = path.join(sandboxHome, '.claude', 'skills');
  const cases: [string, () => void][] = [
    ['skill_files', () => {
      for (let i = 0; i < 201; i += 1) {
        fs.mkdirSync(path.join(library, 'alpha', 'many'), { recursive: true });
        fs.writeFileSync(path.join(library, 'alpha', 'many', `f${i}.txt`), 'x');
      }
    }],
    ['depth', () => {
      const deep = path.join(library, 'alpha', 'a', 'b', 'c', 'd', 'e', 'f');
      fs.mkdirSync(deep, { recursive: true });
      fs.writeFileSync(path.join(deep, 'g.txt'), 'x');
    }],
  ];
  try {
    for (const [detail, arrange] of cases) {
      fs.rmSync(library, { recursive: true, force: true });
      claudeFixture(owner);
      arrange();
      const res = await call('PUT', '/me', owner, { mode: 'private' });
      assert.equal(res.status, 422, detail);
      assert.equal(res.json.code, 'HARNESS_FILES_SEED_TOO_LARGE');
      assert.deepEqual(modeRows(), []);
      assert.equal(fs.existsSync(privateSkillsStoreRoot(owner.id, 'claude')), false);
    }
  } finally {
    fs.rmSync(library, { recursive: true, force: true });
  }
});

test('a symlink in any store component fails the switch with 422 PATH_REJECTED', async () => {
  const outside = path.join(sandboxHome, 'outside-target');
  const userRoot = path.join(sandboxHome, '.nassaj-users', String(owner.id));
  const components = ['.nassaj-private', path.join('.nassaj-private', 'claude'),
    path.join('.nassaj-private', 'claude', 'skills')];
  for (const component of components) {
    resetState();
    fs.rmSync(outside, { recursive: true, force: true });
    fs.mkdirSync(outside, { recursive: true });
    const linkAt = path.join(userRoot, component);
    fs.mkdirSync(path.dirname(linkAt), { recursive: true });
    fs.symlinkSync(outside, linkAt);
    const res = await call('PUT', '/me', owner, { mode: 'private' });
    assert.equal(res.status, 422, component);
    assert.equal(res.json.code, 'HARNESS_FILES_PATH_REJECTED');
    assert.deepEqual(fs.readdirSync(outside), [], `nothing written through ${component}`);
    assert.deepEqual(modeRows(), []);
  }
  fs.rmSync(outside, { recursive: true, force: true });
});
