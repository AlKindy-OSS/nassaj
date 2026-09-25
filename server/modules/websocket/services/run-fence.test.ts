/* eslint-disable boundaries/dependencies -- the fence is proven against the real registry and database. */
/**
 * T-1854 / ADR-172 amendment — authority per run, proven against the REAL
 * fenced-run registry, the real membership mutators and the real
 * WebSocketWriter (fan-out, outcome, primary suppression). Only the provider
 * abort bridge is a spy.
 */

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test, { after, before, beforeEach } from 'node:test';

import {
  closeConnection,
  getConnection,
  initializeDatabase,
  projectMembersDb,
  projectsDb,
  userDb,
} from '@/modules/database/index.js';
import {
  __fencedRunCountForTests,
  __resetProjectFenceStateForTests,
  __setProjectFenceRotationFailureForTests,
  armFencedRun,
  releaseFencedRun,
  rotateProjectSubjectAccess,
} from '@/modules/database/repositories/project-access.js';
import {
  createRunFence,
  OUTPUT_ACCESS_RECHECK_MS,
  type RunFenceAbort,
} from '@/modules/websocket/services/run-fence.js';
import {
  addSessionMirror,
  removeSessionMirrorsForSocket,
  WebSocketWriter,
} from '@/modules/websocket/services/websocket-writer.service.js';

type User = { id: number };
type Socket = { readyState: number; userId: number | null; received: Record<string, unknown>[]; send(frame: string): void };

let owner: User;
let admin: User;
let creator: User;
let member: User;
let other: User;
let projectId = '';
let projectPath = '';
let root = '';

const socket = (userId: number | null): Socket => {
  const received: Record<string, unknown>[] = [];
  return { readyState: 1, userId, received, send: (frame: string) => { received.push(JSON.parse(frame)); } };
};

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

function fence(userId: number, abortRun: RunFenceAbort = () => true, primary = socket(userId)) {
  const inner = new WebSocketWriter(primary as never, userId);
  const runFence = createRunFence({ inner, provider: 'claude', knownSessionId: null, echo: {}, abortRun });
  return { primary, inner, runFence, writer: runFence.writer };
}

before(async () => {
  closeConnection();
  root = fs.mkdtempSync(path.join(os.tmpdir(), 't1854-run-fence-'));
  process.env.WORKSPACES_ROOT = root;
  await initializeDatabase();
  owner = userDb.createUser('rf_owner', 'hash', 'owner') as User;
  admin = userDb.createUser('rf_admin', 'hash', 'admin') as User;
  creator = userDb.createUser('rf_creator', 'hash', 'user') as User;
  member = userDb.createUser('rf_member', 'hash', 'user') as User;
  other = userDb.createUser('rf_other', 'hash', 'user') as User;
  projectPath = fs.mkdtempSync(path.join(root, 'proj-'));
  projectId = projectsDb.createProjectPath(projectPath, 'RunFence', creator.id).project?.project_id ?? '';
});

beforeEach(() => {
  __resetProjectFenceStateForTests();
  projectMembersDb.addAndRotateProjectAccess(projectId, member.id, 'member', creator.id);
  projectMembersDb.addAndRotateProjectAccess(projectId, other.id, 'member', creator.id);
});

after(() => {
  __resetProjectFenceStateForTests();
  delete process.env.WORKSPACES_ROOT;
  closeConnection();
});

test('arm admits a current member and refuses a user without access', () => {
  const stranger = userDb.createUser('rf_stranger', 'hash', 'user') as User;
  assert.equal(fence(member.id).runFence.arm(projectId, member.id), true);
  assert.equal(fence(stranger.id).runFence.arm(projectId, stranger.id), false);
  assert.equal(__fencedRunCountForTests(), 1);
});

test('removal: frames drop at commit, ONE contentless terminal frame, sanitized idle (qa M2, test 28)', async () => {
  const { primary, runFence, writer } = fence(member.id);
  const mirror = socket(owner.id);
  addSessionMirror('rf-s1', mirror as never);
  try {
    assert.equal(runFence.arm(projectId, member.id), true);
    writer.send({ kind: 'session_created', sessionId: 'rf-s1', newSessionId: 'rf-s1' });
    writer.send({ kind: 'text', sessionId: 'rf-s1', content: 'before' });
    assert.equal(primary.received.length, 2);

    projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
    assert.equal(writer.runFenceRevoked, true, 'revoked synchronously at the commit');
    writer.send({ kind: 'text', sessionId: 'rf-s1', content: 'after-commit secret' });
    await tick();
    writer.send({ kind: 'complete', sessionId: 'rf-s1', success: true });
    writer.send({
      kind: 'status', text: 'process_state', processState: 'idle', sessionId: 'rf-s1',
      provider: 'claude', content: 'leak', extra: 'x',
    });

    const after = primary.received.slice(2);
    assert.equal(after.some((frame) => JSON.stringify(frame).includes('secret')), false);
    const terminals = after.filter((frame) => frame.kind === 'complete');
    assert.equal(terminals.length, 1, 'exactly one terminal frame');
    assert.deepEqual(Object.keys(terminals[0]).sort(), [
      'aborted', 'code', 'exitCode', 'id', 'kind', 'provider', 'sessionId', 'success', 'timestamp',
    ]);
    assert.equal(terminals[0].code, 'project_access_changed');
    assert.equal(terminals[0].sessionId, 'rf-s1');
    const idle = after.filter((frame) => frame.text === 'process_state');
    assert.equal(idle.length, 1);
    assert.deepEqual(Object.keys(idle[0]).sort(),
      ['id', 'kind', 'processState', 'provider', 'sessionId', 'text', 'timestamp']);
    assert.equal(idle[0].processState, 'idle');
    assert.deepEqual(mirror.received.map((frame) => frame.kind),
      ['session_created', 'text', 'complete', 'status'],
      'other viewers get the terminal frame and idle, nothing after the commit');
  } finally {
    removeSessionMirrorsForSocket(mirror as never);
  }
});

test('qa H1a: abort is retried on every dropped frame until the bridge confirms', async () => {
  const results: unknown[] = [false, Promise.resolve({ aborted: false }), Promise.resolve(true)];
  const calls: string[] = [];
  const { runFence, writer } = fence(member.id, (_writer, sessionId) => {
    calls.push(sessionId);
    return results.shift() ?? true;
  });
  assert.equal(runFence.arm(projectId, member.id), true);
  writer.send({ kind: 'session_created', sessionId: 'rf-h1', newSessionId: 'rf-h1' });
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  await tick();
  assert.deepEqual(calls, ['rf-h1'], 'first attempt: provider not registered yet');
  writer.send({ kind: 'status', text: 'process_state', processState: 'running', sessionId: 'rf-h1' });
  await tick();
  assert.equal(calls.length, 2, 'a dropped process_state re-invokes the abort');
  assert.equal(__fencedRunCountForTests(), 1, 'unconfirmed abort keeps the run registered');
  writer.send({ kind: 'text', sessionId: 'rf-h1', content: 'x' });
  await tick();
  assert.equal(calls.length, 3);
  assert.equal(__fencedRunCountForTests(), 0, 'confirmed abort releases the entry (qa M4)');
  writer.send({ kind: 'text', sessionId: 'rf-h1', content: 'y' });
  await tick();
  assert.equal(calls.length, 3, 'no abort after confirmation');
});

test('qa M3: no terminal frame through the writer until the sessionId is explicit', async () => {
  const primary = socket(member.id);
  const staleViewer = socket(owner.id);
  const { runFence, writer, inner } = fence(member.id, () => false, primary);
  inner.setSessionId('someone-elses-session');
  addSessionMirror('someone-elses-session', staleViewer as never);
  try {
    assert.equal(runFence.arm(projectId, member.id), true);
    projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
    await tick();
    assert.deepEqual(primary.received, [], 'unknown session: nothing sent yet');
    writer.setSessionId('rf-m3');
    assert.equal(primary.received.length, 1);
    assert.equal(primary.received[0].sessionId, 'rf-m3');
    assert.deepEqual(staleViewer.received, [], 'never attributed to the connection sessionId');
  } finally {
    removeSessionMirrorsForSocket(staleViewer as never);
  }
});

test('qa M3: a session never learned ends with a raw notStarted frame to the primary only', async () => {
  const primary = socket(member.id);
  const staleViewer = socket(owner.id);
  const { runFence, inner } = fence(member.id, () => false, primary);
  inner.setSessionId('connection-level-session');
  addSessionMirror('connection-level-session', staleViewer as never);
  try {
    assert.equal(runFence.arm(projectId, member.id), true);
    projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
    await tick();
    runFence.finish();
    assert.equal(primary.received.length, 1);
    assert.equal(primary.received[0].notStarted, true);
    assert.equal(primary.received[0].code, 'project_access_changed');
    assert.equal('sessionId' in primary.received[0], false);
    assert.deepEqual(staleViewer.received, []);
    assert.equal(__fencedRunCountForTests(), 0);
  } finally {
    removeSessionMirrorsForSocket(staleViewer as never);
  }
});

test('qa M5/I9: release waits for dispatch end AND idle; a continuing complete holds the run', () => {
  const { runFence, writer } = fence(member.id);
  assert.equal(runFence.arm(projectId, member.id), true);
  writer.send({ kind: 'status', text: 'process_state', processState: 'running', sessionId: 'rf-m5' });
  writer.send({ kind: 'complete', sessionId: 'rf-m5', pendingWorkflows: 2 });
  runFence.finish();
  assert.equal(__fencedRunCountForTests(), 1, 'background workflows keep the run fenced');
  writer.send({ kind: 'status', text: 'process_state', processState: 'idle', sessionId: 'rf-m5' });
  assert.equal(__fencedRunCountForTests(), 0);

  const early = fence(member.id);
  assert.equal(early.runFence.arm(projectId, member.id), true);
  early.writer.send({ kind: 'status', text: 'process_state', processState: 'running', sessionId: 'rf-m5b' });
  early.writer.send({ kind: 'status', text: 'process_state', processState: 'idle', sessionId: 'rf-m5b' });
  assert.equal(__fencedRunCountForTests(), 1, 'idle before the dispatch returned: still held');
  early.runFence.finish();
  assert.equal(__fencedRunCountForTests(), 0, 'whichever is later');
});

test('I7 / qa M6: a member run on a removed user\'s socket mutes only that socket', async () => {
  const foreignPrimary = socket(other.id);
  const memberTab = socket(member.id);
  const { runFence, writer, inner } = fence(member.id, () => true, foreignPrimary);
  addSessionMirror('rf-m6', memberTab as never);
  try {
    assert.equal(runFence.arm(projectId, member.id), true);
    projectMembersDb.removeAndRotateProjectAccess(projectId, other.id);
    await tick();
    writer.send({ kind: 'text', sessionId: 'rf-m6', content: 'members only' });
    assert.equal(writer.runFenceRevoked, false, 'the member keeps authority');
    assert.deepEqual(foreignPrimary.received, [], 'the removed user\'s socket receives nothing');
    assert.equal(memberTab.received.length, 1, 'authorized mirrors keep streaming');
    assert.equal(inner.ws, foreignPrimary as never, 'socket never swapped');
    assert.equal(inner.isPrimarySocketAlive(), true, 'B-SEC-DUP-RUN still sees a live listener');
  } finally {
    removeSessionMirrorsForSocket(memberTab as never);
  }
});

test('I3: remove then re-add before the abort lands — the old run stays revoked, a new one streams', async () => {
  const old = fence(member.id, () => false);
  assert.equal(old.runFence.arm(projectId, member.id), true);
  old.writer.send({ kind: 'session_created', sessionId: 'rf-i3', newSessionId: 'rf-i3' });
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  projectMembersDb.addAndRotateProjectAccess(projectId, member.id, 'member', creator.id);
  await tick();
  old.writer.send({ kind: 'text', sessionId: 'rf-i3', content: 'old tail' });
  assert.equal(old.primary.received.some((frame) => frame.content === 'old tail'), false);
  assert.equal(old.writer.isRunOutputRevoked('rf-i3'), true, 'no transcript persistence either');

  const fresh = fence(member.id);
  assert.equal(fresh.runFence.arm(projectId, member.id), true);
  fresh.writer.send({ kind: 'text', sessionId: 'rf-i3-new', content: 'new run' });
  assert.equal(fresh.primary.received.length, 1);
  assert.equal(fresh.writer.isRunOutputRevoked('rf-i3-new'), false, 'test 1: re-add restores output');
});

test('C1: benign rotations never touch a run (role change, archive, admin row, creator transfer)', async () => {
  const runs = [member, other, admin, creator].map((user) => {
    const handle = fence(user.id);
    assert.equal(handle.runFence.arm(projectId, user.id), true);
    return handle;
  });
  projectMembersDb.addAndRotateProjectAccess(projectId, member.id, 'owner', creator.id);
  projectsDb.updateProjectIsArchivedById(projectId, true);
  projectsDb.updateProjectIsArchivedById(projectId, false);
  projectMembersDb.addAndRotateProjectAccess(projectId, admin.id, 'member', creator.id);
  projectMembersDb.removeAndRotateProjectAccess(projectId, admin.id);
  projectsDb.transferProjectCreator(projectId, other.id);
  rotateProjectSubjectAccess(projectId, member.id);
  await tick();
  for (const handle of runs) {
    const expectedRevoked = handle.inner.userId === creator.id;
    assert.equal(handle.writer.runFenceRevoked, expectedRevoked,
      'only the former creator without a membership row loses access');
  }
  projectsDb.transferProjectCreator(projectId, creator.id);
});

test('tests 21-24: setRole, setStatus, deleteUser and project deletion revoke the affected runs', async () => {
  const demoted = userDb.createUser('rf_demoted_admin', 'hash', 'admin') as User;
  const disabled = userDb.createUser('rf_disabled', 'hash', 'user') as User;
  const deleted = userDb.createUser('rf_deleted', 'hash', 'user') as User;
  projectMembersDb.addAndRotateProjectAccess(projectId, disabled.id, 'member', creator.id);
  projectMembersDb.addAndRotateProjectAccess(projectId, deleted.id, 'member', creator.id);
  const demotedRun = fence(demoted.id);
  const disabledRun = fence(disabled.id);
  const deletedRun = fence(deleted.id);
  for (const [handle, user] of [[demotedRun, demoted], [disabledRun, disabled], [deletedRun, deleted]] as const) {
    assert.equal(handle.runFence.arm(projectId, user.id), true);
  }
  userDb.setRole(demoted.id, 'user');
  userDb.setStatus(disabled.id, 'disabled');
  userDb.deleteUser(deleted.id);
  assert.equal(demotedRun.writer.runFenceRevoked, true, 'admin demotion without a row');
  assert.equal(disabledRun.writer.runFenceRevoked, true);
  assert.equal(deletedRun.writer.runFenceRevoked, true);

  const doomedPath = fs.mkdtempSync(path.join(root, 'doomed-'));
  const doomedId = projectsDb.createProjectPath(doomedPath, 'Doomed', creator.id).project?.project_id ?? '';
  const doomedRun = fence(creator.id);
  assert.equal(doomedRun.runFence.arm(doomedId, creator.id), true);
  projectsDb.deleteProjectById(doomedId);
  assert.equal(doomedRun.writer.runFenceRevoked, true, 'test 24: project deletion');
  await tick();
});

test('test 7: an unprovable rotation aborts every fenced run as unverifiable and refuses new ones', async () => {
  const handle = fence(member.id);
  assert.equal(handle.runFence.arm(projectId, member.id), true);
  handle.writer.send({ kind: 'session_created', sessionId: 'rf-t7', newSessionId: 'rf-t7' });
  __setProjectFenceRotationFailureForTests(true);
  try {
    rotateProjectSubjectAccess(projectId, other.id);
    await tick();
    assert.equal(handle.writer.runFenceRevoked, true);
    const terminal = handle.primary.received.find((frame) => frame.kind === 'complete');
    assert.equal(terminal?.code, 'project_access_unverifiable');
    assert.equal(fence(member.id).runFence.arm(projectId, member.id), false);
  } finally {
    __resetProjectFenceStateForTests();
  }
});

test('R5 / qa M-B: the database re-check runs once per window, a denial is sticky', () => {
  let clock = 10_000;
  const inner = new WebSocketWriter(socket(other.id) as never, other.id);
  const runFence = createRunFence({
    inner, provider: 'claude', knownSessionId: null, echo: {}, abortRun: () => true, now: () => clock,
  });
  const { writer } = runFence;
  assert.equal(runFence.arm(projectId, other.id), true);
  assert.equal(writer.isRunOutputRevoked('rf-r5'), false, 'first line reads the database: allowed');
  getConnection().prepare('DELETE FROM project_members WHERE project_id = ? AND user_id = ?').run(projectId, other.id);
  for (let line = 0; line < 50; line += 1) {
    clock += 10;
    assert.equal(writer.isRunOutputRevoked('rf-r5'), false,
      'inside the window no line re-reads the database (it would see the raw delete)');
  }
  clock += OUTPUT_ACCESS_RECHECK_MS;
  assert.equal(writer.runFenceRevoked, false, 'no sweep ran');
  assert.equal(writer.isRunOutputRevoked('rf-r5'), true, 'the raw mutation is caught once the window elapses');
  getConnection().prepare('INSERT INTO project_members (project_id, user_id, role) VALUES (?, ?, ?)')
    .run(projectId, other.id, 'member');
  clock += OUTPUT_ACCESS_RECHECK_MS;
  assert.equal(writer.isRunOutputRevoked('rf-r5'), true, 'a denial is sticky');
});

test('qa M-B: a sweep revocation is seen at once, inside the recheck window', () => {
  const clock = 10_000;
  const inner = new WebSocketWriter(socket(member.id) as never, member.id);
  const runFence = createRunFence({
    inner, provider: 'claude', knownSessionId: null, echo: {}, abortRun: () => true, now: () => clock,
  });
  assert.equal(runFence.arm(projectId, member.id), true);
  assert.equal(runFence.writer.isRunOutputRevoked('rf-mb'), false);
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  assert.equal(runFence.writer.isRunOutputRevoked('rf-mb'), true, 'same clock tick, via the sweep');
});

test('qa M-A: primary suppression follows the socket — an authorized re-take receives output', async () => {
  const foreignPrimary = socket(other.id);
  const ownerSocket = socket(member.id);
  const { runFence, writer, inner } = fence(member.id, () => true, foreignPrimary);
  assert.equal(runFence.arm(projectId, member.id), true);
  projectMembersDb.removeAndRotateProjectAccess(projectId, other.id);
  await tick();
  writer.send({ kind: 'text', sessionId: 'rf-ma', content: 'muted' });
  assert.deepEqual(foreignPrimary.received, []);
  inner.updateWebSocket(ownerSocket as never);
  writer.send({ kind: 'text', sessionId: 'rf-ma', content: 'delivered' });
  assert.deepEqual(ownerSocket.received.map((frame) => frame.content), ['delivered']);
  assert.deepEqual(foreignPrimary.received, [], 'the removed socket still gets nothing');
});

test('qa #6: a session re-registered to another writer is not ended by this fence', async () => {
  const aborts: string[] = [];
  const primary = socket(member.id);
  const inner = new WebSocketWriter(primary as never, member.id);
  const runFence = createRunFence({
    inner, provider: 'claude', knownSessionId: null, echo: {},
    abortRun: (_writer, sessionId) => { aborts.push(sessionId); return false; },
    sessionOwnedElsewhere: (_writer, sessionId) => sessionId === 'rf-taken',
  });
  assert.equal(runFence.arm(projectId, member.id), true);
  runFence.writer.send({ kind: 'session_created', sessionId: 'rf-taken', newSessionId: 'rf-taken' });
  projectMembersDb.removeAndRotateProjectAccess(projectId, member.id);
  await tick();
  runFence.writer.send({ kind: 'text', sessionId: 'rf-taken', content: 'x' });
  assert.equal(primary.received.filter((frame) => frame.kind === 'complete').length, 0,
    'no terminal frame for a session another run now owns');
  assert.deepEqual(aborts, [], 'and no abort of the other run');
  assert.equal(__fencedRunCountForTests(), 0, 'the entry is released');
});

test('test 30: 100 runs return the registry to zero; direct arm/release is idempotent', () => {
  for (let index = 0; index < 100; index += 1) {
    const handle = fence(member.id);
    assert.equal(handle.runFence.arm(projectId, member.id), true);
    handle.writer.send({ kind: 'status', text: 'process_state', processState: 'running', sessionId: `rf-${index}` });
    handle.writer.send({ kind: 'status', text: 'process_state', processState: 'idle', sessionId: `rf-${index}` });
    handle.runFence.finish();
  }
  assert.equal(__fencedRunCountForTests(), 0);
  const run = armFencedRun({ projectId, userId: member.id, onRevoke: () => undefined });
  releaseFencedRun(run);
  releaseFencedRun(run);
  assert.equal(__fencedRunCountForTests(), 0);
});
