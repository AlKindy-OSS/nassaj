/**
 * T-2003 C3 (ADR-203) — skills providers follow the caller's shared/private
 * mode, and a member may write ONLY to their own private store.
 *
 * Real router, real database and real providers under a sandbox HOME; a
 * stand-in auth middleware injects `req.user` as authenticateToken would.
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
  closeConnection,
  harnessFilesModeDb,
  initializeDatabase,
  userDb,
} from '@/modules/database/index.js';
import { withHarnessFilesLock } from '@/services/isolation/harness-files-lock.js';
import { PRIVATE_SKILLS_FLAG } from '@/services/isolation/harness-files-mode.js';
import { privateSkillsStoreRoot, seedPrivateSkillsStore } from '@/services/isolation/private-skills-store.js';
import { SkillsProvider } from '@/modules/providers/shared/skills/skills.provider.js';
import type { ProviderSkillSource } from '@/shared/types.js';
import { AppError } from '@/shared/utils.js';

type TestUser = { id: number; role: string };
type Json = Record<string, any>;

let server: Server;
let baseUrl = '';
let home = '';
let dbDir = '';
let originalHome: string | undefined;
let currentUser: TestUser | null = null;
let member: TestUser;
let owner: TestUser;
let workspaceCounter = 0;

const skillMd = (name: string, text = 'body') => `---\nname: ${name}\ndescription: ${name} d\n---\n\n${text}\n`;
const library = () => path.join(home, '.claude', 'skills');

async function call(method: string, urlPath: string, user: TestUser, body?: unknown) {
  currentUser = user;
  const response = await fetch(`${baseUrl}/api/providers${urlPath}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: response.status, json: (await response.json().catch(() => ({}))) as Json };
}

/** A fresh workspace per listing so the Claude scan cache never answers. */
async function list(provider: string, user: TestUser): Promise<Json[]> {
  workspaceCounter += 1;
  const ws = path.join(home, `ws-${workspaceCounter}`);
  fs.mkdirSync(ws, { recursive: true });
  const res = await call('GET', `/${provider}/skills?workspacePath=${encodeURIComponent(ws)}`, user);
  assert.equal(res.status, 200);
  return res.json.data.skills as Json[];
}

const addBody = (name: string, extra: Record<string, unknown> = {}) => ({
  entries: [{ content: skillMd(name), directoryName: name }],
  ...extra,
});

function setPrivate(user: TestUser, allowMembers = true): void {
  harnessFilesModeDb.setAllowMemberPrivate(allowMembers);
  harnessFilesModeDb.setStoredMode(user.id, 'private');
  seedPrivateSkillsStore(user.id, 'claude');
  seedPrivateSkillsStore(user.id, 'codex');
}

before(async () => {
  originalHome = process.env.HOME;
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-private-home-'));
  dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skills-private-db-'));
  process.env.HOME = home;
  process.env.DATABASE_PATH = path.join(dbDir, 'db.sqlite');
  delete process.env.VITE_IS_PLATFORM;
  process.env.NASSAJ_CORE_DIR = path.join(home, 'core');
  fs.mkdirSync(process.env.NASSAJ_CORE_DIR, { recursive: true });
  closeConnection();
  await initializeDatabase();
  const m = userDb.createUser('sp_member', 'hash', 'user') as { id: number };
  const o = userDb.createUser('sp_owner', 'hash', 'user') as { id: number };
  userDb.setRole(o.id, 'owner');
  member = { id: m.id, role: 'user' };
  fs.mkdirSync(path.join(library(), 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(library(), 'alpha', 'SKILL.md'), skillMd('alpha', 'shared'));
  owner = { id: o.id, role: 'owner' };

  const { default: providerRouter } = await import('../provider.routes.js');
  const app = express();
  app.use(express.json({ limit: '5mb' }));
  app.use((req, _res, next) => { (req as unknown as { user: unknown }).user = currentUser; next(); });
  app.use('/api/providers', providerRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ error: err.message, code: err.code });
      return;
    }
    res.status(500).json({ error: String(err) });
  });
  await new Promise<void>((resolve) => { server = app.listen(0, '127.0.0.1', resolve); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
  harnessFilesModeDb.setStoredMode(member.id, 'shared');
  harnessFilesModeDb.setStoredMode(owner.id, 'shared');
  harnessFilesModeDb.setAllowMemberPrivate(false);
  fs.rmSync(path.join(home, '.nassaj-users'), { recursive: true, force: true });
  fs.rmSync(library(), { recursive: true, force: true });
  fs.mkdirSync(path.join(library(), 'alpha'), { recursive: true });
  fs.writeFileSync(path.join(library(), 'alpha', 'SKILL.md'), skillMd('alpha', 'shared'));
  delete process.env[PRIVATE_SKILLS_FLAG];
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  closeConnection();
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(dbDir, { recursive: true, force: true });
});

test('member in shared mode (or private with the flag off) cannot write', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  assert.equal((await call('POST', '/claude/skills', member, addBody('x'))).json.code, 'PROVIDER_SKILL_WRITE_FORBIDDEN');
  assert.equal((await call('DELETE', '/codex/skills/alpha', member)).status, 403);
  setPrivate(member);
  process.env[PRIVATE_SKILLS_FLAG] = '0';
  assert.equal((await call('POST', '/claude/skills', member, addBody('x'))).status, 403);
});

test('member in private mode writes only to their own store; body userId ignored', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  setPrivate(member);
  const res = await call('POST', '/claude/skills', member, addBody('mine', { userId: owner.id }));
  assert.equal(res.status, 200);
  const store = privateSkillsStoreRoot(member.id, 'claude');
  assert.ok(fs.existsSync(path.join(store, 'mine', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(library(), 'mine')), false);
  assert.equal(fs.existsSync(path.join(home, '.nassaj-users', String(owner.id), '.nassaj-private')), false);
  const skills = await list('claude', member);
  const user = skills.filter((s) => s.scope === 'user');
  assert.deepEqual(user.map((s) => s.name).sort(), ['alpha', 'mine']);
  assert.equal(user.filter((s) => s.name === 'alpha').length, 1, 'no duplicate row for a shadowed shared skill');
  assert.ok(user.every((s) => !s.readOnly && s.origin === undefined));
  assert.equal((await call('DELETE', '/claude/skills/mine', member)).status, 200);
  assert.equal(fs.existsSync(path.join(store, 'mine')), false);
  assert.equal((await call('DELETE', '/claude/skills/alpha', member)).status, 200);
  assert.ok(fs.existsSync(path.join(library(), 'alpha', 'SKILL.md')), 'shared library untouched');
});

test('a symlinked skill in the private store is refused as a write target', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  setPrivate(member);
  const outside = path.join(home, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'keep.txt'), 'keep');
  fs.symlinkSync(outside, path.join(privateSkillsStoreRoot(member.id, 'claude'), 'evil'));
  const res = await call('DELETE', '/claude/skills/evil', member);
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'PROVIDER_SKILL_PRIVATE_PATH_REJECTED');
  const add = await call('POST', '/claude/skills', member, addBody('evil'));
  assert.equal(add.status, 400);
  assert.ok(fs.existsSync(path.join(outside, 'keep.txt')));
});

test('Codex private mode: store listed editable, nassaj-shared hidden, writes land in the store', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  setPrivate(member);
  assert.equal((await call('POST', '/codex/skills', member, addBody('cx'))).status, 200);
  assert.ok(fs.existsSync(path.join(privateSkillsStoreRoot(member.id, 'codex'), 'cx', 'SKILL.md')));
  const skills = await list('codex', member);
  const cx = skills.find((s) => s.name === 'cx');
  assert.ok(cx && !cx.readOnly && cx.scope === 'user');
  assert.equal(skills.some((s) => s.origin === 'nassaj-shared'), false);
});

test('owner: private writes go to the owner store, shared writes to the library', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  assert.equal((await call('POST', '/claude/skills', owner, addBody('lib-skill'))).status, 200);
  assert.ok(fs.existsSync(path.join(library(), 'lib-skill', 'SKILL.md')));
  setPrivate(owner, false);
  assert.equal((await call('POST', '/claude/skills', owner, addBody('own-skill'))).status, 200);
  assert.ok(fs.existsSync(path.join(privateSkillsStoreRoot(owner.id, 'claude'), 'own-skill', 'SKILL.md')));
  assert.equal(fs.existsSync(path.join(library(), 'own-skill')), false);
});

test('mode changed while the write waits for the lock → 409, nothing written', async () => {
  process.env[PRIVATE_SKILLS_FLAG] = '1';
  setPrivate(member);
  let release: () => void = () => {};
  const held = withHarnessFilesLock(member.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const pending = call('POST', '/claude/skills', member, addBody('late'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  harnessFilesModeDb.setAllowMemberPrivate(false);
  release();
  await held;
  const res = await pending;
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'HARNESS_FILES_MODE_CHANGED');
  assert.equal(fs.existsSync(path.join(privateSkillsStoreRoot(member.id, 'claude'), 'late')), false);
  assert.equal(fs.existsSync(path.join(library(), 'late')), false);
});

/** A provider whose writable root no longer matches the permission's pin. */
class DriftedProvider extends SkillsProvider {
  constructor(private readonly root: string) { super('claude'); }
  protected async getSkillSources(): Promise<ProviderSkillSource[]> { return []; }
  protected async getGlobalSkillSource(): Promise<ProviderSkillSource> {
    return { scope: 'user', rootDir: this.root, commandPrefix: '/' };
  }
}

test('member write pinned to the private store: a drifted source root → 409, nothing written', async () => {
  const sharedRoot = path.join(home, 'drift-shared');
  fs.mkdirSync(path.join(sharedRoot, 'keep'), { recursive: true });
  fs.writeFileSync(path.join(sharedRoot, 'keep', 'SKILL.md'), skillMd('keep'));
  fs.writeFileSync(path.join(sharedRoot, 'keep', '.nassaj-skill.json'), '{}');
  const provider = new DriftedProvider(sharedRoot);
  const pin = privateSkillsStoreRoot(member.id, 'claude');
  await assert.rejects(
    provider.addSkills({ entries: [{ content: skillMd('x') }], userId: member.id, requiredRootDir: pin }),
    (err: unknown) => err instanceof AppError && err.code === 'HARNESS_FILES_MODE_CHANGED' && err.statusCode === 409,
  );
  await assert.rejects(
    provider.removeSkill('keep', { userId: member.id, requiredRootDir: pin }),
    (err: unknown) => err instanceof AppError && err.code === 'HARNESS_FILES_MODE_CHANGED',
  );
  assert.deepEqual(fs.readdirSync(sharedRoot), ['keep']);
  assert.ok(fs.existsSync(path.join(sharedRoot, 'keep', 'SKILL.md')));
  const ok = await provider.addSkills({ entries: [{ content: skillMd('y') }], userId: owner.id });
  assert.equal(ok.length, 1);
});

// ---- ADR-203 C5 test matrix (rows not covered above) -------------------------

test('flag unset (shipped default): a member in private mode writes to their own store', async () => {
  setPrivate(member);
  const res = await call('POST', '/claude/skills', member, addBody('default-on'));
  assert.equal(res.status, 200);
  assert.ok(fs.existsSync(path.join(privateSkillsStoreRoot(member.id, 'claude'), 'default-on', 'SKILL.md')));
});

test('flag unset: a member with a saved private choice but the switch OFF cannot write', async () => {
  setPrivate(member, false);
  const res = await call('POST', '/claude/skills', member, addBody('blocked'));
  assert.equal(res.status, 403);
  assert.equal(res.json.code, 'PROVIDER_SKILL_WRITE_FORBIDDEN');
  assert.equal(fs.existsSync(path.join(privateSkillsStoreRoot(member.id, 'claude'), 'blocked')), false);
});

test('shared-only harnesses stay owner/admin even for a member in private mode', async () => {
  setPrivate(member);
  const statuses: Record<string, number> = {};
  for (const provider of ['qwen', 'opencode', 'cursor', 'gemini']) {
    const res = await call('POST', `/${provider}/skills`, member, addBody('nope'));
    statuses[provider] = res.status;
    // 403 = role gate; 400 = a retired body refused before any write.
    assert.ok(res.status === 403 || res.status === 400, `${provider}: ${res.status}`);
  }
  assert.ok(Object.values(statuses).includes(403), JSON.stringify(statuses));
  assert.equal(fs.existsSync(path.join(home, '.nassaj-users', String(member.id), '.nassaj-private', 'nope')), false);
});

test('path spoofing over the API: traversal names never escape the private store', async () => {
  setPrivate(member);
  const before = fs.readdirSync(home).sort();
  for (const name of ['..', '../../escape', '../shared', '.hidden', '/etc/x']) {
    const res = await call('POST', '/claude/skills', member, addBody(name));
    if (res.status === 200) {
      const created = (res.json.data.skills as Json[]).map((s) => String(s.name));
      for (const entry of fs.readdirSync(privateSkillsStoreRoot(member.id, 'claude'))) {
        assert.match(entry, /^[A-Za-z0-9_][A-Za-z0-9._-]*$/, `normalized ${name} → ${created}`);
      }
    } else {
      assert.equal(res.status, 400, name);
    }
  }
  assert.deepEqual(fs.readdirSync(home).sort(), before, 'nothing created beside the store');
  assert.deepEqual(fs.readdirSync(library()), ['alpha'], 'shared library untouched');
  const del = await call('DELETE', '/claude/skills/..%2F..%2Fshared', member);
  assert.ok(del.status >= 400 && del.status < 500);
  assert.ok(fs.existsSync(path.join(library(), 'alpha', 'SKILL.md')));
});

test('a symlinked store component rejects member writes over the API', async () => {
  setPrivate(member);
  const outside = path.join(home, 'outside-component');
  fs.mkdirSync(outside, { recursive: true });
  const store = privateSkillsStoreRoot(member.id, 'claude');
  fs.rmSync(store, { recursive: true });
  fs.symlinkSync(outside, store);
  const res = await call('POST', '/claude/skills', member, addBody('through'));
  assert.equal(res.status, 400);
  assert.equal(res.json.code, 'PROVIDER_SKILL_PRIVATE_PATH_REJECTED');
  assert.deepEqual(fs.readdirSync(outside), []);
  const skills = await list('claude', member);
  assert.equal(skills.some((s) => s.name === 'through'), false);
});

test('DELETE while the mode changes under the lock → 409 and the skill stays', async () => {
  setPrivate(member);
  const store = privateSkillsStoreRoot(member.id, 'claude');
  assert.equal((await call('POST', '/claude/skills', member, addBody('keepme'))).status, 200);
  let release: () => void = () => {};
  const held = withHarnessFilesLock(member.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const pending = call('DELETE', '/claude/skills/keepme', member);
  await new Promise((resolve) => setTimeout(resolve, 50));
  harnessFilesModeDb.setStoredMode(member.id, 'shared');
  release();
  await held;
  const res = await pending;
  assert.equal(res.status, 409);
  assert.equal(res.json.code, 'HARNESS_FILES_MODE_CHANGED');
  assert.ok(fs.existsSync(path.join(store, 'keepme', 'SKILL.md')));
});

test('owner going private mid-write: a shared-root write waiting on the lock → 409', async () => {
  let release: () => void = () => {};
  const held = withHarnessFilesLock(owner.id, () => new Promise<void>((resolve) => { release = resolve; }));
  const pending = call('POST', '/claude/skills', owner, addBody('racer'));
  await new Promise((resolve) => setTimeout(resolve, 50));
  harnessFilesModeDb.setStoredMode(owner.id, 'private');
  release();
  await held;
  const res = await pending;
  assert.equal(res.status, 409);
  assert.equal(fs.existsSync(path.join(library(), 'racer')), false);
});

test('private listing: shared library hidden for the member, shared again after switching back', async () => {
  setPrivate(member);
  fs.rmSync(path.join(privateSkillsStoreRoot(member.id, 'claude'), 'alpha'), { recursive: true });
  const priv = await list('claude', member);
  assert.equal(priv.some((s) => s.name === 'alpha'), false, 'shared alpha hidden in private mode');
  harnessFilesModeDb.setStoredMode(member.id, 'shared');
  const shared = await list('claude', member);
  const alpha = shared.find((s) => s.name === 'alpha');
  assert.ok(alpha, 'shared alpha visible again');
});
