/* eslint-disable boundaries/dependencies, boundaries/no-unknown -- cross-module release matrix exercises real composition seams. */
/**
 * ADR-172 project membership & visibility — role matrix, flag-off parity,
 * members API, member candidates, live-subscription revocation, WS gates and
 * the seeding script. Fixtures are rows of the real schema created through the
 * real repositories (initializeDatabase + userDb/projectsDb/sessionsDb).
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

import express from 'express';

import {
  canAccessProject,
  canAccessRegisteredProjectPath,
  captureProjectFence,
  closeConnection,
  describePlatformModeVisibilityRisk,
  getConnection,
  initializeDatabase,
  isProjectFenceCurrent,
  messageAuthorsDb,
  projectMembersDb,
  projectsDb,
  sessionsDb,
  userDb,
} from '@/modules/database/index.js';
import { isSessionAccessibleByUser, sessionsService } from '@/modules/providers/services/sessions.service.js';
import {
  isProjectPathVisibleToUser as wsProjectPathVisible,
  isSessionVisibleToUser,
  isSessionWritableByUser,
} from '@/modules/websocket/services/chat-websocket.service.js';
import { revokeProjectLiveAccess } from '@/modules/websocket/services/project-membership-revocation.service.js';
import { addSessionMirror, WebSocketWriter } from '@/modules/websocket/services/websocket-writer.service.js';
import {
  __registerShellSessionForTests,
  terminateShellSessionsForUserInProject,
} from '@/modules/websocket/services/shell-websocket.service.js';
import {
  onMemberRemoved,
  recoverOrphanByTransfer,
  type MemberRemovedEvent,
} from '@/modules/projects/services/project-visibility-management.service.js';
import { findOwningProject } from '@/modules/database/repositories/project-access.js';
import { AppError, normalizeProjectPath as serverNormalize } from '@/shared/utils.js';

import projectsRouter from '../projects.routes.js';
import { attachSessionTitles } from '../../../services/live-session-titles.js';
import { createDocumentSharesRouter } from '../../../routes/document-shares.js';
import {
  applySeedPlan,
  assertExpectedHash,
  computeSeedPlan,
  normalizeProjectPath as seedNormalize,
} from '../../../../scripts/project-membership-seed.mjs';

type User = { id: number; role: string; username: string };

let server: Server;
let baseUrl = '';
let currentUser: User | null = null;
let owner: User;
let admin: User;
let creator: User;
let member: User;
let stranger: User;
let participant: User;
let disabledAdmin: User;
let projectId = '';
let projectPath = '';
let workspaceRoot = '';
const SESSION_ID = 'adr172-session-0001';

function enforce(on: boolean): void {
  process.env.PROJECT_MEMBERSHIP_ENFORCE = on ? '1' : '0';
}

function makeUser(name: string, role: 'owner' | 'admin' | 'user' = 'user'): User {
  return userDb.createUser(name, 'hash', role) as User;
}

async function call(method: string, urlPath: string, user: User | null, body?: unknown) {
  currentUser = user;
  const response = await fetch(`${baseUrl}${urlPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = (await response.json().catch(() => ({}))) as Record<string, any>;
  return { status: response.status, json };
}

function fakeSocket(userId: number) {
  const received: string[] = [];
  const closes: Array<[number | undefined, string | undefined]> = [];
  return {
    readyState: 1, userId, received, closes,
    send(data: string) { received.push(data); },
    close(code?: number, reason?: string) { closes.push([code, reason]); },
    once() {},
  };
}

before(async () => {
  closeConnection();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'adr172-members-'));
  workspaceRoot = root;
  process.env.WORKSPACES_ROOT = root;
  process.env.DATABASE_PATH = path.join(root, 'db.sqlite');
  await initializeDatabase();

  owner = makeUser('m_owner', 'owner');
  admin = makeUser('m_admin', 'admin');
  creator = makeUser('m_creator');
  member = makeUser('m_member');
  stranger = makeUser('m_stranger');
  participant = makeUser('m_participant');
  disabledAdmin = makeUser('m_disabled_admin', 'admin');
  userDb.setStatus(disabledAdmin.id, 'disabled');

  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  projectId = projectsDb.createProjectPath(projectPath, 'ADR172', creator.id).project?.project_id ?? '';
  projectMembersDb.add(projectId, member.id, 'member', creator.id);
  sessionsDb.createSession(SESSION_ID, 'claude', projectPath, 'S');
  getConnection()
    .prepare("INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'spawn')")
    .run(SESSION_ID, participant.id);

  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as unknown as { user: User | null }).user = currentUser;
    next();
  });
  app.use('/api/projects', projectsRouter);
  app.use((err: unknown, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    const status = err instanceof AppError ? err.statusCode : 500;
    res.status(status).json({ success: false, error: { code: err instanceof AppError ? err.code : 'INTERNAL' } });
  });
  server = app.listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(() => enforce(true));

after(async () => {
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  delete process.env.WORKSPACES_ROOT;
  await new Promise((resolve) => server.close(resolve));
  closeConnection();
});

test('role matrix with enforcement on', () => {
  const cases: Array<[string, User | null, boolean]> = [
    ['owner', null, true], ['admin', null, true], ['creator', null, true], ['member', null, true],
    ['stranger', null, false], ['session participant (not member)', null, false],
    ['disabled admin', null, false],
  ];
  const users: Record<string, User> = {
    owner, admin, creator, member, stranger, 'session participant (not member)': participant,
    'disabled admin': disabledAdmin,
  };
  for (const [name, , expected] of cases) {
    const id = users[name].id;
    assert.equal(projectsDb.isProjectVisibleToUser(projectId, id), expected, `visible: ${name}`);
    assert.equal(projectsDb.isProjectWritableByUser(projectId, id), expected, `writable: ${name}`);
    assert.equal(projectsDb.isProjectPathVisibleToUser(projectPath, id), expected, `path: ${name}`);
    assert.equal(projectsDb.getVisibleProjectPaths(id).includes(projectPath), expected, `list: ${name}`);
  }
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, null), false, 'anonymous');
  assert.equal(projectsDb.getVisibleProjectPaths(null).length, 0, 'anonymous list');
  assert.equal(projectsDb.isProjectVisibleToUser('no-such-project', owner.id), false, 'unknown id');
});

test('flag off keeps ADR-089 behaviour exactly', () => {
  enforce(false);
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, stranger.id), true, 'everyone reads');
  assert.equal(projectsDb.getVisibleProjectPaths(stranger.id).includes(projectPath), true);
  assert.equal(projectsDb.isProjectPathVisibleToUser(projectPath, stranger.id), true);
  assert.equal(projectsDb.isProjectWritableByUser(projectId, stranger.id), false, 'stranger cannot write');
  assert.equal(projectsDb.isProjectWritableByUser(projectId, participant.id), true, 'participant arm kept');
  assert.equal(projectsDb.isProjectWritableByUser(projectId, admin.id), false, 'admin gains nothing');
  delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, stranger.id), true, 'unset = off');
});

test('isPlatformOwner is unchanged: admin cannot run orphan recovery', async () => {
  const adminStatus = await call('GET', `/api/projects/${projectId}/orphan-status`, admin);
  assert.equal(adminStatus.status, 403);
  const ownerStatus = await call('GET', `/api/projects/${projectId}/orphan-status`, owner);
  assert.equal(ownerStatus.status, 200);
  assert.throws(() => recoverOrphanByTransfer(projectId, admin.id, false), (e: unknown) => e instanceof AppError && e.statusCode === 403);
});

test('members API: member manages, non-member gets 404, creator cannot be removed', async () => {
  for (const on of [true, false]) {
    enforce(on);
    assert.equal((await call('GET', `/api/projects/${projectId}/members`, stranger)).status, 404, `flag ${on}`);
  }
  enforce(true);
  const listed = await call('GET', `/api/projects/${projectId}/members`, member);
  assert.equal(listed.status, 200);
  assert.equal((await call('GET', `/api/projects/${projectId}/members`, admin)).status, 200, 'admin');

  const added = await call('POST', `/api/projects/${projectId}/members`, member, { userId: stranger.id });
  assert.equal(added.status, 200);
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, stranger.id), true);

  const removeCreator = await call('DELETE', `/api/projects/${projectId}/members/${creator.id}`, member);
  assert.equal(removeCreator.status, 409);
  assert.equal(removeCreator.json.error.code, 'cannot_remove_creator');

  const reclassifyCreator = await call('POST', `/api/projects/${projectId}/members`, member, {
    userId: creator.id, role: 'member',
  });
  assert.equal(reclassifyCreator.status, 409, 'creator is immutable even without an explicit row');
  assert.equal(reclassifyCreator.json.error.code, 'cannot_change_creator_role');

  assert.equal((await call('DELETE', `/api/projects/${projectId}/members/${stranger.id}junk`, member)).status, 400);
  assert.equal((await call('POST', `/api/projects/${projectId}/members`, member, {
    userId: stranger.id, role: 'unexpected',
  })).status, 400);

  const removed = await call('DELETE', `/api/projects/${projectId}/members/${stranger.id}`, member);
  assert.equal(removed.status, 200);
  assert.equal(projectsDb.isProjectVisibleToUser(projectId, stranger.id), false);

  const actions = getConnection()
    .prepare("SELECT action, user_id, metadata FROM audit_log WHERE action LIKE 'project.member.%' ORDER BY id")
    .all() as Array<{ action: string; user_id: number; metadata: string }>;
  assert.deepEqual(actions.map((a) => a.action), ['project.member.add', 'project.member.remove']);
  assert.equal(actions[1].user_id, member.id);
  assert.equal(JSON.parse(actions[1].metadata).targetUserId, stranger.id);
});

test('member candidates: short q, limit 20, disabled + members excluded, minimal fields', async () => {
  for (let i = 0; i < 25; i += 1) makeUser(`cand_${String(i).padStart(2, '0')}`);
  const disabled = makeUser('cand_disabled');
  userDb.setStatus(disabled.id, 'disabled');
  projectMembersDb.add(projectId, makeUser('cand_already_member').id, 'member', null);

  assert.equal((await call('GET', `/api/projects/${projectId}/member-candidates?q=c`, creator)).status, 400);
  assert.equal((await call('GET', `/api/projects/${projectId}/member-candidates?q=cand`, stranger)).status, 404);

  const result = await call('GET', `/api/projects/${projectId}/member-candidates?q=cand`, creator);
  assert.equal(result.status, 200);
  const candidates = result.json.data.candidates as Array<Record<string, unknown>>;
  assert.equal(candidates.length, 20);
  assert.deepEqual(Object.keys(candidates[0]).sort(), ['avatar', 'displayName', 'id']);
  const names = candidates.map((c) => c.displayName);
  assert.ok(!names.includes('cand_disabled'));
  assert.ok(!names.includes('cand_already_member'));

  const wildcard = await call('GET', `/api/projects/${projectId}/member-candidates?q=%25%25`, creator);
  assert.equal(wildcard.json.data.candidates.length, 0, 'LIKE wildcards are literal');
});

test('member candidates are rate limited to 30/min per user', async () => {
  const limited = makeUser('rate_limited_member');
  projectMembersDb.add(projectId, limited.id, 'member', null);
  const statuses: number[] = [];
  for (let i = 0; i < 31; i += 1) {
    statuses.push((await call('GET', `/api/projects/${projectId}/member-candidates?q=zz`, limited)).status);
  }
  assert.equal(statuses.filter((s) => s === 200).length, 30);
  assert.equal(statuses[30], 429);
});

test('removal emits an event; admin keeps access, a plain member loses it', async () => {
  const events: MemberRemovedEvent[] = [];
  const unsubscribe = onMemberRemoved((event) => events.push(event));
  try {
    projectMembersDb.add(projectId, stranger.id, 'member', null);
    projectMembersDb.add(projectId, admin.id, 'member', null);
    await call('DELETE', `/api/projects/${projectId}/members/${stranger.id}`, creator);
    await call('DELETE', `/api/projects/${projectId}/members/${admin.id}`, creator);
    assert.deepEqual(events.map((e) => [e.userId, e.stillHasAccess]), [[stranger.id, false], [admin.id, true]]);
    assert.equal(events[0].projectPath, projectPath);
  } finally {
    unsubscribe();
  }
});

test('P1-2: a removed member stops receiving the next live message', () => {
  const primary = fakeSocket(creator.id);
  const removedTab = fakeSocket(stranger.id);
  const otherViewer = fakeSocket(member.id);
  addSessionMirror(SESSION_ID, removedTab as any);
  addSessionMirror(SESSION_ID, otherViewer as any);
  const writer = new WebSocketWriter(primary as any, creator.id);
  writer.setSessionId(SESSION_ID);

  writer.send({ type: 'probe', sessionId: SESSION_ID, n: 1 });
  assert.equal(removedTab.received.length, 1);

  let refreshed = 0;
  const outcome = revokeProjectLiveAccess(
    { projectId, projectPath, userId: stranger.id, stillHasAccess: false },
    { clients: [primary, removedTab, otherViewer] as any, refreshPresence: () => { refreshed += 1; },
      terminateShells: () => 0 },
  );
  assert.equal(outcome.mirrorsRemoved, 1);
  assert.equal(outcome.socketsNotified, 1);
  assert.deepEqual(removedTab.closes, [], 'T-1854: the chat socket is never closed (no 4404)');
  assert.equal(refreshed, 1);
  assert.equal(JSON.parse(removedTab.received[1]).type, 'project_membership_revoked');

  writer.send({ type: 'probe', sessionId: SESSION_ID, n: 2 });
  assert.equal(removedTab.received.length, 2, 'no stream message after removal');
  assert.equal(otherViewer.received.length, 2, 'other members unaffected');

  const kept = fakeSocket(admin.id);
  addSessionMirror(SESSION_ID, kept as any);
  const adminOutcome = revokeProjectLiveAccess(
    { projectId, projectPath, userId: admin.id, stillHasAccess: true },
    { clients: [kept] as any, refreshPresence: () => {}, terminateShells: () => 0 },
  );
  assert.equal(adminOutcome.mirrorsRemoved, 0, 'still-authorized user keeps the stream');
});

test('T-1854 (design test 9): the listener sends the notice only — no fence, no 4404 close', () => {
  const order: string[] = [];
  const socket = {
    readyState: 1, userId: stranger.id,
    send: () => order.push('notice'),
    close: (code?: number, reason?: string) => order.push(`close:${code}:${reason}`),
    once() {},
  };
  const outcome = revokeProjectLiveAccess(
    { projectId, projectPath, userId: stranger.id, stillHasAccess: false },
    { clients: [socket as any], refreshPresence: () => {}, terminateShells: () => 0 },
  );
  assert.deepEqual(order, ['notice'], 'the socket carries other projects: it stays open');
  assert.equal(outcome.socketsNotified, 1);
  assert.equal('socketsClosed' in outcome, false);
});

test('WS gates that take a project follow enforcement', () => {
  assert.equal(wsProjectPathVisible(projectPath, stranger.id), false);
  assert.equal(isSessionVisibleToUser(SESSION_ID, stranger.id), false);
  assert.equal(isSessionWritableByUser(SESSION_ID, stranger.id), false);
  assert.equal(wsProjectPathVisible(projectPath, member.id), true);
  assert.equal(isSessionVisibleToUser(SESSION_ID, admin.id), true);
  const titled = attachSessionTitles([{ sessionId: SESSION_ID }], stranger.id);
  assert.equal(titled[0].titleRedacted, true, 'live session titles redacted for non-member');
  enforce(false);
  assert.equal(isSessionVisibleToUser(SESSION_ID, stranger.id), true, 'flag off unchanged');
});

test('projectless existing sessions require participant or author consent', () => {
  enforce(true);
  const projectless = 'adr172-projectless-consent';
  const author = makeUser('projectless_author');
  const projectlessParticipant = makeUser('projectless_participant');
  const guessed = makeUser('projectless_guesser');
  sessionsDb.createSession(projectless, 'claude', projectPath, 'Projectless');
  getConnection().prepare('UPDATE sessions SET project_path = NULL WHERE session_id = ?').run(projectless);
  messageAuthorsDb.recordUserMessage(projectless, author.id, 'consented prompt');
  getConnection().prepare(
    "INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'spawn')",
  ).run(projectless, projectlessParticipant.id);

  assert.equal(isSessionVisibleToUser(projectless, guessed.id), false);
  assert.equal(isSessionWritableByUser(projectless, guessed.id), false);
  assert.equal(isSessionAccessibleByUser(projectless, null, guessed.id, 'read'), false);
  assert.equal(isSessionVisibleToUser(projectless, owner.id), false, 'platform owner still needs consent');
  assert.equal(isSessionVisibleToUser(projectless, admin.id), false, 'platform admin still needs consent');
  assert.equal(isSessionVisibleToUser(projectless, author.id), true);
  assert.equal(isSessionWritableByUser(projectless, author.id), false, 'authorship grants read, not control');
  assert.equal(isSessionAccessibleByUser(projectless, null, author.id, 'read'), true);
  assert.equal(isSessionWritableByUser(projectless, projectlessParticipant.id), true);
  assert.equal(isSessionVisibleToUser('guessed-unknown-session', guessed.id), false);
  getConnection().prepare('UPDATE sessions SET isArchived = 1 WHERE session_id = ?').run(projectless);
  assert.equal(sessionsService.listArchivedSessions(guessed.id).some((row) => row.sessionId === projectless), false);
  assert.equal(sessionsService.listArchivedSessions(author.id).some((row) => row.sessionId === projectless), true);

  const originalLookup = sessionsDb.getSessionById;
  sessionsDb.getSessionById = (() => { throw new Error('fixture lookup failure'); }) as typeof originalLookup;
  try {
    assert.equal(isSessionVisibleToUser(projectless, author.id), false, 'lookup errors deny');
    assert.equal(isSessionWritableByUser(projectless, projectlessParticipant.id), false, 'lookup errors deny control');
  } finally {
    sessionsDb.getSessionById = originalLookup;
  }
});

test('platform-mode advisory warns and never throws', () => {
  assert.equal(describePlatformModeVisibilityRisk(false, true), null);
  assert.match(describePlatformModeVisibilityRisk(true, true) ?? '', /not meaningful/i);
  assert.match(describePlatformModeVisibilityRisk(true, false) ?? '', /cannot be enforced/);
});

test('seeding: dry run matches apply, apply is idempotent, losses reported', () => {
  const seededProject = projectsDb.createProjectPath(path.join(projectPath, 'seeded'), 'Seeded', null).project!;
  const seededPath = seededProject.project_path;
  sessionsDb.createSession('adr172-seed-session', 'claude', seededPath, 'S2');
  getConnection()
    .prepare("INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'spawn'), (?, ?, 'inferred')")
    .run('adr172-seed-session', participant.id, 'adr172-seed-session', stranger.id);

  const db = getConnection();
  const plan = computeSeedPlan(db);
  const entry = plan.perProject.find((p: any) => p.projectId === seededProject.project_id);
  assert.deepEqual(entry.seedInserts.map((u: any) => u.id), [participant.id], 'spawn only, inferred ignored');
  assert.ok(entry.loseReadAccess.some((u: any) => u.id === stranger.id));
  assert.ok(!entry.loseReadAccess.some((u: any) => u.id === admin.id), 'admin keeps access');
  assert.match(plan.seedSourceCaveat, /SUCCESSFUL launches only/);

  const inserted = applySeedPlan(db, plan);
  assert.equal(inserted, plan.totals.seedInserts);
  assert.equal(applySeedPlan(db, plan), 0, 'second apply inserts nothing');
  assert.equal(computeSeedPlan(db).totals.seedInserts, 0, 'dry run after apply is empty');
  assert.equal(projectsDb.isProjectVisibleToUser(seededProject.project_id, participant.id), true);
});

test('P1-3: document-share management follows canManageProject; public reads stay outside', async () => {
  const plain = { id: member.id, role: 'user' };
  const store = { project: (id: string) => (id === projectId ? { project_id: projectId, project_path: projectPath } : null), list: () => [] };
  const statusFor = async (canManageProject?: (pid: string, uid: number) => boolean) => {
    const app = express();
    app.use('/api', createDocumentSharesRouter({
      getStore: () => store, verifyUser: () => plain, isMember: () => false,
      ...(canManageProject ? { canManageProject } : {}),
    }));
    const srv = app.listen(0);
    await new Promise((resolve) => srv.once('listening', resolve));
    try {
      const port = (srv.address() as AddressInfo).port;
      const response = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/document-shares`, {
        headers: { Authorization: 'Bearer x' },
      });
      return response.status;
    } finally {
      await new Promise((resolve) => srv.close(resolve));
    }
  };
  assert.equal(await statusFor(), 403, 'default (flag off wiring) = admin-only as before');
  assert.equal(await statusFor(() => false), 403);
  assert.equal(await statusFor((pid, uid) => pid === projectId && uid === member.id), 200);
});

test('GET members: display identity, creator listed, viewer flags, no email/system role', async () => {
  getConnection().prepare('UPDATE users SET git_email = ?, avatar_url = ? WHERE id = ?')
    .run('secret@example.com', '/avatars/m.png', member.id);
  projectMembersDb.remove(projectId, creator.id); // the seeding test gave the creator a row
  const asMember = await call('GET', `/api/projects/${projectId}/members`, member);
  assert.equal(asMember.status, 200);
  const { members, viewer } = asMember.json.data;
  assert.deepEqual(viewer, {
    isMember: true, adminAccess: false, canManageMembers: true, canManageOwnerRole: false,
  });

  const expectedKeys = ['added_by', 'avatar', 'created_at', 'displayName', 'isCreator', 'project_id',
    'role', 'userId', 'user_id'];
  for (const entry of members) assert.deepEqual(Object.keys(entry).sort(), expectedKeys);
  assert.deepEqual(members[0], {
    project_id: projectId, user_id: creator.id, added_by: null, created_at: null,
    userId: creator.id, displayName: 'm_creator', avatar: null, role: 'owner', isCreator: true,
  }, 'creator without an explicit row is listed first');
  const self = members.find((m: any) => m.userId === member.id);
  assert.equal(self.displayName, 'm_member');
  assert.equal(self.avatar, '/avatars/m.png');
  assert.equal(self.isCreator, false);
  const raw = JSON.stringify(asMember.json);
  assert.ok(!raw.includes('secret@example.com') && !/"(email|git_email|status|password_hash)"/.test(raw));

  const asCreator = await call('GET', `/api/projects/${projectId}/members`, creator);
  assert.deepEqual(asCreator.json.data.viewer, {
    isMember: true, adminAccess: false, canManageMembers: true, canManageOwnerRole: true,
  });
  const asAdmin = await call('GET', `/api/projects/${projectId}/members`, admin);
  assert.deepEqual(asAdmin.json.data.viewer, {
    isMember: false, adminAccess: true, canManageMembers: true, canManageOwnerRole: false,
  });
  assert.ok(!asAdmin.json.data.members.some((m: any) => m.userId === admin.id));
  projectMembersDb.add(projectId, admin.id, 'member', null);
  const adminMember = await call('GET', `/api/projects/${projectId}/members`, admin);
  assert.deepEqual(adminMember.json.data.viewer, {
    isMember: true, adminAccess: false, canManageMembers: true, canManageOwnerRole: false,
  });
  assert.equal(projectMembersDb.listByProjectWithIdentity(projectId).filter((r) => r.is_creator === 1).length, 1);
});

test('#10: disabled target refused, creator not a candidate, no-op removal not audited', async () => {
  const off = makeUser('t10_disabled');
  userDb.setStatus(off.id, 'disabled');
  assert.equal((await call('POST', `/api/projects/${projectId}/members`, member, { userId: off.id })).status, 404);

  projectMembersDb.remove(projectId, creator.id);
  const found = await call('GET', `/api/projects/${projectId}/member-candidates?q=m_cre`, member);
  assert.equal(found.json.data.candidates.length, 0, 'creator is never offered as a candidate');

  const events: MemberRemovedEvent[] = [];
  const unsubscribe = onMemberRemoved((event) => events.push(event));
  const count = () => (getConnection()
    .prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'project.member.remove'").get() as { n: number }).n;
  try {
    const before = count();
    const noop = await call('DELETE', `/api/projects/${projectId}/members/${off.id}`, member);
    assert.equal(noop.status, 200);
    assert.equal(count(), before, 'no audit row for a non-member');
    assert.equal(events.length, 0, 'no revocation event for a non-member');
  } finally {
    unsubscribe();
  }
});

test('#9: --apply needs the reviewed plan hash; paths are joined normalized', () => {
  const db = getConnection();
  const plan = computeSeedPlan(db);
  assert.match(plan.planHash, /^[a-f0-9]{64}$/);
  assert.equal(computeSeedPlan(db).planHash, plan.planHash, 'hash is stable (generatedAt excluded)');
  assert.throws(() => assertExpectedHash(plan, undefined), /requires --expect-hash/);
  assert.throws(() => assertExpectedHash(plan, 'f'.repeat(64)), /plan changed/);
  assert.doesNotThrow(() => assertExpectedHash(plan, plan.planHash));

  const late = makeUser('t9_late_launcher');
  sessionsDb.createSession('adr172-t9-session', 'claude', projectPath, 'late');
  db.prepare("INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'spawn')")
    .run('adr172-t9-session', late.id);
  assert.throws(() => assertExpectedHash(computeSeedPlan(db), plan.planHash), /plan changed/,
    'a launch after the dry run invalidates the approved hash');

  assert.equal(seedNormalize('/a/b/'), '/a/b');
  assert.equal(seedNormalize(' /a/./b//c/ '), '/a/b/c');
  assert.equal(seedNormalize('/'), '/');
});

test('#4: sub-directory, `..` and symlink paths are gated by the owning project', () => {
  const sub = path.join(projectPath, 'sub');
  fs.mkdirSync(sub, { recursive: true });
  const outside = fs.mkdtempSync(path.join(workspaceRoot, 'adr172-outside-'));
  const link = path.join(outside, 'link-into-project');
  fs.symlinkSync(sub, link);
  const sibling = `${projectPath}-sibling`;
  fs.mkdirSync(sibling, { recursive: true });

  for (const cwd of [sub, path.join(sub, 'deeper/not-yet-created'), `${sub}/../sub`, link]) {
    assert.equal(wsProjectPathVisible(cwd, stranger.id), false, `stranger refused: ${cwd}`);
    assert.equal(wsProjectPathVisible(cwd, member.id), true, `member allowed: ${cwd}`);
    assert.equal(wsProjectPathVisible(cwd, admin.id), true, `admin allowed: ${cwd}`);
  }
  assert.equal(wsProjectPathVisible(outside, stranger.id), true, 'rooted unregistered location = creation flow');
  assert.equal(wsProjectPathVisible(sibling, stranger.id), true, 'prefix sibling is not inside the project');
  assert.equal(wsProjectPathVisible(os.tmpdir(), stranger.id), false, 'outside WORKSPACES_ROOT denied');
  const missingOutsideRoot = path.join(path.dirname(workspaceRoot), 'missing-outside-root', 'child');
  assert.equal(wsProjectPathVisible(missingOutsideRoot, stranger.id), false,
    'missing ancestors outside WORKSPACES_ROOT are denied');
  const dangling = path.join(workspaceRoot, 'dangling');
  fs.symlinkSync(path.join(workspaceRoot, 'missing-target'), dangling);
  assert.equal(wsProjectPathVisible(dangling, stranger.id), false, 'dangling symlink denied');

  enforce(false);
  assert.equal(wsProjectPathVisible(sub, stranger.id), true, 'flag off: unregistered sub path unchanged');
});

test('#5: a session participant who is not a member cannot write/resume under enforcement', () => {
  // A launcher of SESSION_ID (spawn row) who never became / is no longer a member.
  const launcher = makeUser('t5_launcher');
  getConnection().prepare("INSERT INTO session_participants (session_id, user_id, attribution) VALUES (?, ?, 'spawn')")
    .run(SESSION_ID, launcher.id);
  assert.equal(isSessionWritableByUser(SESSION_ID, launcher.id), false);
  assert.equal(isSessionWritableByUser(SESSION_ID, member.id), true);
  enforce(false);
  assert.equal(isSessionWritableByUser(SESSION_ID, launcher.id), true, 'flag off: participant arm kept');
});

test('#6: revocation ends the removed user\'s /shell PTYs; the socket writer is not detached', () => {
  const own = fakeSocket(stranger.id);
  const writer = new WebSocketWriter(own as any, stranger.id);
  writer.setSessionId(SESSION_ID);
  writer.send({ type: 'probe', sessionId: SESSION_ID });
  const otherProjectSession = 'adr172-other-project-session';
  writer.send({ type: 'probe', sessionId: otherProjectSession });
  assert.equal(own.received.length, 2);

  const calls: string[] = [];
  const entry = (tag: string, entryPath: string) => ({
    pty: { kill: () => calls.push(`kill:${tag}`) },
    ws: { close: (code: number) => calls.push(`close:${tag}:${code}`) },
    buffer: [], timeoutId: null, projectPath: entryPath, sessionId: null,
    writerLease: { release: () => calls.push(`release:${tag}`) },
  });
  __registerShellSessionForTests(`${stranger.id}_${projectPath}_default`, entry('root', projectPath) as any);
  __registerShellSessionForTests(`${stranger.id}_${projectPath}/sub_default`, entry('sub', `${projectPath}/sub`) as any);
  __registerShellSessionForTests(`${member.id}_${projectPath}_default`, entry('member', projectPath) as any);
  __registerShellSessionForTests(`${stranger.id}_${projectPath}-sibling_default`, entry('sib', `${projectPath}-sibling`) as any);

  const outcome = revokeProjectLiveAccess(
    { projectId, projectPath, userId: stranger.id, stillHasAccess: false },
    { clients: [], refreshPresence: () => {} },
  );
  assert.equal(outcome.shellsEnded, 2);
  assert.deepEqual(calls.sort(), ['close:root:4404', 'close:sub:4404', 'kill:root', 'kill:sub',
    'release:root', 'release:sub']);

  // T-1854: authority is per run (chat-websocket.run-fence tests). The shared
  // connection writer keeps no per-session detach, so a later re-add streams.
  writer.send({ type: 'probe', sessionId: SESSION_ID });
  assert.equal(own.received.length, 3, 'no connection-level detach survives the removal');
  writer.send({ type: 'probe', sessionId: otherProjectSession });
  assert.equal(own.received.length, 4, 'other projects keep streaming');

  assert.equal(terminateShellSessionsForUserInProject(member.id, projectPath), 1, 'cleanup member entry');
  assert.equal(terminateShellSessionsForUserInProject(stranger.id, `${projectPath}-sibling`), 1);
});

test('owner decision 2026-09-23: only managers grant/change/remove the owner role', async () => {
  const base = `/api/projects/${projectId}/members`;
  const projOwner = makeUser('d1_project_owner');
  projectMembersDb.add(projectId, projOwner.id, 'owner', creator.id);
  const plain = makeUser('d1_plain');
  const other = makeUser('d1_other');
  projectMembersDb.add(projectId, plain.id, 'member', creator.id);
  projectMembersDb.add(projectId, admin.id, 'member', creator.id);
  const roleOf = (id: number) => projectMembersDb.getRole(projectId, id);

  // Member: self-promotion, granting owner, demoting or removing an owner → 403.
  assert.equal((await call('POST', base, member, { userId: member.id, role: 'owner' })).status, 403);
  assert.equal((await call('POST', base, member, { userId: other.id, role: 'owner' })).status, 403);
  assert.equal((await call('POST', base, member, { userId: projOwner.id, role: 'member' })).status, 403);
  assert.equal((await call('DELETE', `${base}/${projOwner.id}`, member)).status, 403);
  assert.equal(roleOf(member.id), 'member');
  assert.equal(roleOf(other.id), null);
  assert.equal(roleOf(projOwner.id), 'owner');

  // Admin (sees all projects) does not gain the management right.
  assert.equal((await call('POST', base, admin, { userId: admin.id, role: 'owner' })).status, 403);
  assert.equal((await call('DELETE', `${base}/${projOwner.id}`, admin)).status, 403);
  // A stranger still gets 404, not 403.
  assert.equal((await call('POST', base, stranger, { userId: stranger.id, role: 'owner' })).status, 404);

  // Member can still add members and remove regular members.
  assert.equal((await call('POST', base, member, { userId: other.id })).status, 200);
  assert.equal(roleOf(other.id), 'member');
  assert.equal((await call('DELETE', `${base}/${other.id}`, member)).status, 200);
  assert.equal((await call('POST', base, member, { userId: plain.id })).status, 200, 'idempotent re-add');

  // Creator, project owner and platform owner can.
  assert.equal((await call('POST', base, creator, { userId: plain.id, role: 'owner' })).status, 200);
  assert.equal(roleOf(plain.id), 'owner');
  assert.equal((await call('POST', base, projOwner, { userId: plain.id, role: 'member' })).status, 200);
  assert.equal(roleOf(plain.id), 'member');
  assert.equal((await call('POST', base, owner, { userId: plain.id, role: 'owner' })).status, 200);
  assert.equal((await call('DELETE', `${base}/${plain.id}`, projOwner)).status, 200);
  assert.equal(roleOf(plain.id), null);
});

test('owner decision 2026-09-23 (qa #7): share management and member reads follow canAccessProject', async () => {
  const cases: Array<[User, boolean]> = [[admin, true], [owner, true], [creator, true], [member, true], [stranger, false]];
  for (const [user, expected] of cases) {
    assert.equal(canAccessRegisteredProjectPath(projectPath, user.id), expected, user.username);
  }
  assert.equal(canAccessRegisteredProjectPath(path.join(projectPath, 'sub'), admin.id), false, 'exact project only');
  assert.equal(canAccessRegisteredProjectPath('', admin.id), false);
  const archived = projectsDb.createProjectPath(path.join(projectPath, 'archived'), 'A', creator.id).project!;
  projectsDb.updateProjectIsArchivedById(archived.project_id, true);
  assert.equal(canAccessRegisteredProjectPath(archived.project_path, creator.id), false, 'archived excluded');

  // Management through the real router with the production wiring: a plain member manages.
  const plainMember = { id: member.id, role: 'user' };
  const shareApp = express();
  shareApp.use('/api', createDocumentSharesRouter({
    getStore: () => ({ project: (id: string) => (id === projectId ? { project_id: projectId, project_path: projectPath } : null), list: () => [] }),
    verifyUser: () => plainMember,
    isMember: (root: string, id: number) => canAccessRegisteredProjectPath(root, id),
    canManageProject: (pid: string, id: number) => canAccessProject(pid, id),
  }));
  const srv = shareApp.listen(0);
  await new Promise((resolve) => srv.once('listening', resolve));
  try {
    const port = (srv.address() as AddressInfo).port;
    const list = await fetch(`http://127.0.0.1:${port}/api/projects/${projectId}/document-shares`, {
      headers: { Authorization: 'Bearer x' },
    });
    assert.equal(list.status, 200, 'member manages share links');
  } finally {
    await new Promise((resolve) => srv.close(resolve));
  }
});

test('qa م7: seed normalizeProjectPath matches server/shared/utils.ts', () => {
  const inputs = ['/a/b', '/a/b/', ' /a/./b//c/ ', '/', '//', '/a/../b', '/a/b/..', 'rel/dir/', '  ', '', '/x y/z/'];
  for (const input of inputs) assert.equal(seedNormalize(input), serverNormalize(input), JSON.stringify(input));
});

test('qa م6: owning project via real path of a symlink-registered project, and root "/"', () => {
  const realDir = fs.mkdtempSync(path.join(os.tmpdir(), 'adr172-real-'));
  const linkParent = fs.mkdtempSync(path.join(os.tmpdir(), 'adr172-linkp-'));
  const linked = path.join(linkParent, 'registered-via-link');
  fs.symlinkSync(realDir, linked);
  const viaLink = projectsDb.createProjectPath(linked, 'ViaLink', creator.id).project!;
  assert.equal(findOwningProject(path.join(realDir, 'src'))?.project_id, viaLink.project_id, 'real path owned');
  assert.equal(findOwningProject(path.join(linked, 'new/dir'))?.project_id, viaLink.project_id, 'link path, nonexistent tail');

  const root = projectsDb.createProjectPath('/', 'Root', creator.id).project!;
  try {
    assert.equal(findOwningProject('/definitely/unregistered')?.project_id, root.project_id, '"/" owns everything below');
    assert.equal(findOwningProject(path.join(realDir, 'x'))?.project_id, viaLink.project_id, 'longest ancestor wins');
  } finally {
    projectsDb.deleteProjectById(root.project_id);
  }
});

test('qa م2: /shell revocation matches the owning project id even for a symlink-opened PTY', () => {
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'adr172-shell-link-'));
  const link = path.join(outside, 'into-project');
  fs.symlinkSync(projectPath, link);
  const calls: string[] = [];
  __registerShellSessionForTests(`${stranger.id}_${link}_default`, {
    pty: { kill: () => calls.push('kill') }, ws: { close: () => calls.push('close') }, buffer: [],
    timeoutId: null, projectPath: link, projectId: findOwningProject(link)?.project_id ?? null,
    sessionId: null, writerLease: { release: () => calls.push('release') },
  } as any);
  assert.equal(terminateShellSessionsForUserInProject(stranger.id, projectPath, projectId), 1);
  assert.deepEqual(calls.sort(), ['close', 'kill', 'release']);
});

test('owner decision م1: removal stops only the removed member\'s in-flight turns in the project', async () => {
  const { presenceRunStarted, presenceRunStopped } = await import('@/modules/websocket/services/presence.service.js');
  const outside = 'adr172-m1-other-project-session';
  presenceRunStarted({ userId: stranger.id, sessionId: SESSION_ID, provider: 'claude' } as any);
  presenceRunStarted({ userId: stranger.id, sessionId: outside, provider: 'claude' } as any);
  presenceRunStarted({ userId: member.id, sessionId: SESSION_ID, provider: 'claude' } as any);
  const aborted: Array<[string, number]> = [];
  const deps = {
    clients: [], refreshPresence: () => {}, terminateShells: () => 0,
    abortTurn: (sessionId: string, userId: number) => { aborted.push([sessionId, userId]); return true; },
  };
  try {
    const kept = revokeProjectLiveAccess({ projectId, projectPath, userId: stranger.id, stillHasAccess: true }, deps);
    assert.equal(kept.turnsStopped, 0, 'still-authorized (flag off / admin): nothing stopped');
    const outcome = revokeProjectLiveAccess({ projectId, projectPath, userId: stranger.id, stillHasAccess: false }, deps);
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(outcome.turnsStopped, 1);
    assert.deepEqual(aborted, [[SESSION_ID, stranger.id]], 'other project and other member untouched');
  } finally {
    presenceRunStopped({ userId: stranger.id, sessionId: SESSION_ID } as any);
    presenceRunStopped({ userId: stranger.id, sessionId: outside } as any);
    presenceRunStopped({ userId: member.id, sessionId: SESSION_ID } as any);
  }
});

test('abortSessionTurn dispatches to the provider that owns the session', async () => {
  const { abortSessionTurn } = await import('@/modules/websocket/services/chat-websocket.service.js');
  const calls: string[] = [];
  const deps = {
    getSessionProvider: () => 'codex',
    hostedTurnSupervisor: null, cliTurnSupervisor: null,
    abortCodexSession: (id: string) => { calls.push(`codex:${id}`); return true; },
  } as any;
  const result = await abortSessionTurn(deps, SESSION_ID, null, stranger.id);
  assert.equal(result.success, true);
  assert.deepEqual(calls, [`codex:${SESSION_ID}`]);
});

test('re-adding a removed member does not revive their old writer identity', async () => {
  const returning = makeUser('m5_returning');
  const socket = fakeSocket(returning.id);
  const writer = new WebSocketWriter(socket as any, returning.id);
  const terminalCalls: string[] = [];
  __registerShellSessionForTests(`${returning.id}_${projectPath}_default`, {
    pty: { kill: () => terminalCalls.push('kill') },
    ws: { close: () => terminalCalls.push('close') },
    buffer: [], timeoutId: null, projectPath, projectId, sessionId: null,
    writerLease: { release: () => terminalCalls.push('release') },
  } as any);
  const before = userDb.getRawById(returning.id)?.authorization_generation ?? 0;
  revokeProjectLiveAccess({ projectId, projectPath, userId: returning.id, stillHasAccess: false },
    { clients: [socket as any], refreshPresence: () => {} });
  writer.send({ type: 'probe', sessionId: SESSION_ID });
  // T-1854: the notice, then the probe — a connection writer that carries no
  // fenced run is not detached; in-flight runs are fenced per run instead.
  assert.equal(socket.received.length, 2, 'no connection-level detach');

  assert.equal((await call('POST', `/api/projects/${projectId}/members`, member, { userId: returning.id })).status, 200);
  assert.equal(userDb.getRawById(returning.id)?.authorization_generation ?? 0, before,
    'project membership does not invalidate unrelated credentials');
  writer.send({ type: 'probe', sessionId: SESSION_ID });
  assert.equal(socket.received.length, 3, 'T-1854: after re-add the same connection streams (the gap)');
  assert.deepEqual(socket.closes, [], 'an inert viewer socket is not closed as a writer');
  assert.deepEqual(terminalCalls.sort(), ['close', 'kill', 'release']);
  assert.equal(terminateShellSessionsForUserInProject(returning.id, projectPath), 0,
    're-add does not revive the removed PTY');
});

test('membership removal rotates the project subject without advancing global authorization', async () => {
  const removed = makeUser('generation_removed');
  assert.equal((await call('POST', `/api/projects/${projectId}/members`, member, { userId: removed.id })).status, 200);
  const before = userDb.getRawById(removed.id)?.authorization_generation ?? 0;
  const fence = captureProjectFence(projectId, removed.id)!;
  assert.equal((await call('DELETE', `/api/projects/${projectId}/members/${removed.id}`, member)).status, 200);
  assert.equal(userDb.getRawById(removed.id)?.authorization_generation ?? 0, before);
  assert.equal(isProjectFenceCurrent(fence), false);
  assert.equal(projectMembersDb.getRole(projectId, removed.id), null);
});
