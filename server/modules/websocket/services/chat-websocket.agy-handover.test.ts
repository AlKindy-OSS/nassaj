/* eslint-disable boundaries/dependencies -- the handover is proven through the real dispatch, DB, overlay and agy adapter. */
/**
 * Multi-turn antigravity chats under session isolation (the reported bug:
 * every new agy chat failed on turn 2 with "The resumed session has no trusted
 * project workspace").
 *
 * Real database, real overlay module, real isolation wrapper and the real agy
 * adapter; only the `agy` process itself is a fake that files a brain the way
 * agy does (a fresh UUID, never the id it was asked for — see the spike in
 * the commit message). Proves turn 2 resumes in turn 1's workspace in overlay
 * AND shared mode, a rejected handover keeps the spawn key resumable, and two
 * concurrent fresh chats each hand over to their own brain.
 */

// T-1873: harness CLIs resolve to sandbox stubs, never the host's installs.
import '../../../shared/__tests__/stub-harness-binaries.js';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import * as realChildProcess from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import test, { after, before, mock } from 'node:test';

const root = fs.mkdtempSync(path.join(process.env.TMPDIR || '/var/tmp', 'agy-handover-'));
process.env.HOME = root;
/** Where agy files brains for the test user (per-user when agy is isolated). */
let brainRoot = '';

type Spawned = { cwd: string; args: string[]; brainId: string };
const spawned: Spawned[] = [];
let nextBrainId: string | null = null;

/** Files a brain like agy: fresh runs get a NEW uuid, resumes append to theirs. */
function fakeAgy(args: string[], cwd: string) {
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = () => true;
  child.pid = 424242;
  const conversation = args.includes('--conversation') ? args[args.indexOf('--conversation') + 1] : null;
  const brainId = conversation ?? nextBrainId ?? randomUUID();
  nextBrainId = null;
  spawned.push({ cwd, args, brainId });
  setTimeout(() => {
    const logs = path.join(brainRoot, brainId, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    const transcript = path.join(logs, 'transcript.jsonl');
    const prior = fs.existsSync(transcript) ? fs.readFileSync(transcript, 'utf8').split('\n').filter(Boolean).length : 0;
    fs.appendFileSync(transcript, [
      JSON.stringify({ step_index: prior, source: 'USER_EXPLICIT', type: 'USER_INPUT', content: '<instructions>x</instructions>' }),
      JSON.stringify({ step_index: prior + 1, source: 'MODEL', type: 'PLANNER_RESPONSE', status: 'DONE', content: 'ok' }),
    ].join('\n') + '\n');
    (child.stdout as PassThrough).write('ok');
    setTimeout(() => child.emit('close', 0, null), 30);
  }, 30);
  return child;
}

mock.module('child_process', {
  namedExports: {
    ...realChildProcess,
    spawn: (cmd: string, args: string[], options: { cwd: string }) => (
      Array.isArray(args) && args.includes('--dangerously-skip-permissions')
        ? fakeAgy(args, options.cwd)
        : realChildProcess.spawn(cmd, args, options as never)
    ),
  },
});
mock.module('@/modules/providers/services/provider-models.service.js', {
  namedExports: {
    providerModelsService: {
      getChangedActiveModel: () => null,
      getProviderModels: async () => ({ models: { OPTIONS: [] } }),
      resolveResumeModel: async () => null,
      seedSessionModel: async () => undefined,
    },
  },
});

const database = await import('@/modules/database/index.js');
const { closeConnection, initializeDatabase, projectsDb, sessionsDb, userDb, getConnection } = database as never as {
  closeConnection: () => void;
  initializeDatabase: () => Promise<void>;
  projectsDb: { createProjectPath: (p: string, n: string, u: number) => unknown };
  sessionsDb: { createSession: (...args: unknown[]) => void; getSessionById: (id: string) => Record<string, unknown> | null };
  userDb: { createUser: (n: string, h: string, r: string) => { id: number } };
  getConnection: () => { prepare: (sql: string) => { all: (...a: unknown[]) => unknown[]; run: (...a: unknown[]) => unknown } };
};
const { WebSocketWriter } = await import('@/modules/websocket/services/websocket-writer.service.js');
const { dispatchProviderCommand } = await import('@/modules/websocket/services/chat-websocket.service.js');
// eslint-disable-next-line boundaries/no-unknown -- the real agy adapter is the unit under test.
const agy = await import('../../../agy-cli.js');
const { getAgyBrainDir } = await import('@/modules/providers/list/antigravity/agy-brain-dir.js');

type Frame = Record<string, unknown>;
let user: { id: number };

function git(repo: string, ...args: string[]) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

function project(kind: 'repo' | 'folder'): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(root, `proj-${kind}-`)));
  if (kind === 'repo') {
    git(dir, 'init', '-q', '-b', 'main');
    git(dir, 'config', 'user.name', 'Handover');
    git(dir, 'config', 'user.email', 'handover@example.test');
    fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
    git(dir, 'add', 'a.txt');
    git(dir, 'commit', '-q', '-m', 'chore: base');
  }
  projectsDb.createProjectPath(dir, path.basename(dir), user.id);
  return dir;
}

const authorized = () => ({
  kind: 'authorized' as const,
  execution: {
    decisionId: 'agy-handover', leaseId: 'agy-handover', mode: 'legacy' as const,
    consume: () => ({}), markStarted: () => undefined, settle: () => undefined, notStarted: () => undefined,
  },
});

async function turn(cwd: string, sessionId: string | null): Promise<Frame[]> {
  const received: Frame[] = [];
  const socket = { readyState: 1, userId: user.id, send: (frame: string) => received.push(JSON.parse(frame)) };
  const writer = new WebSocketWriter(socket as never, user.id);
  await dispatchProviderCommand(
    'antigravity-command',
    {
      type: 'antigravity-command',
      command: 'say ok',
      options: { cwd, clientMsgId: `cmid-${randomUUID()}`, ...(sessionId ? { sessionId } : {}) },
    } as never,
    writer,
    {
      getSessionProvider: () => 'antigravity',
      authorizeProviderExecution: authorized,
      spawnAntigravity: agy.spawnAntigravity,
      abortAntigravitySession: agy.abortAntigravitySession,
      getActiveAntigravitySessions: agy.getActiveAntigravitySessions,
    } as never,
    user.id,
    Object.freeze({ id: user.id, role: 'user', authenticationKind: 'session', authorizationGeneration: 1 }),
  );
  return received;
}

const created = (frames: Frame[]) => frames.filter((frame) => frame.kind === 'session_created');
const failures = (frames: Frame[]) => frames.filter((frame) => frame.kind === 'complete' && frame.success === false);
const ledger = (id: string) => getConnection()
  .prepare('SELECT mode FROM session_workspace_modes WHERE session_id = ?').all(id) as Array<{ mode: string }>;

before(async () => {
  closeConnection();
  process.env.WORKSPACES_ROOT = root;
  await initializeDatabase();
  user = userDb.createUser('agy_handover_user', 'hash', 'user');
  brainRoot = getAgyBrainDir(user.id);
});

after(() => {
  closeConnection();
  delete process.env.WORKSPACES_ROOT;
  for (const entry of fs.readdirSync(root)) {
    const dir = path.join(root, entry);
    if (entry.startsWith('proj-repo-')) git(dir, 'worktree', 'prune');
  }
  fs.rmSync(root, { recursive: true, force: true });
});

const variants = [
  ['overlay', 'repo', false],
  ['legacy_shared', 'folder', false],
  ['overlay', 'repo', true],
] as const;
for (const [mode, kind, enforced] of variants) {
  test(`two-turn agy chat (${mode}${enforced ? ', membership enforced' : ''}): turn 2 resumes in turn 1's workspace`, async (t) => {
    if (enforced) {
      process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
      t.after(() => { delete process.env.PROJECT_MEMBERSHIP_ENFORCE; });
    }
    const dir = project(kind);
    spawned.length = 0;
    const first = await turn(dir, null);
    assert.deepEqual(failures(first), [], JSON.stringify(first));
    const [spawnKeyFrame, handoverFrame, ...extra] = created(first);
    assert.deepEqual(extra, [], 'the durable id is announced exactly once');
    const spawnKey = String(spawnKeyFrame.newSessionId);
    const brainId = String(handoverFrame.newSessionId);
    assert.match(spawnKey, /^agy_\d+_[a-z0-9]+$/);
    assert.equal(brainId, spawned[0].brainId);
    assert.equal(handoverFrame.parentSessionId, spawnKey, 'qa M5: the client migrates only the spawn-key view');
    assert.equal(sessionsDb.getSessionById(spawnKey), null, 'the stub was adopted');
    assert.deepEqual(ledger(spawnKey), []);
    assert.deepEqual(ledger(brainId), [{ mode }]);
    const participants = getConnection()
      .prepare('SELECT user_id FROM session_participants WHERE session_id = ?').all(brainId);
    assert.deepEqual(participants, [{ user_id: user.id }], 'qa M3: participants moved before the emit');
    if (mode === 'overlay') {
      assert.equal(handoverFrame.workspaceGeneration, spawnKeyFrame.workspaceGeneration);
      assert.notEqual(spawned[0].cwd, dir, 'turn 1 ran in an overlay');
    } else {
      assert.equal(handoverFrame.workspaceIsolation, 'legacy_shared');
      assert.equal(spawned[0].cwd, dir);
    }

    const second = await turn(dir, brainId);
    assert.deepEqual(failures(second), [], JSON.stringify(second));
    assert.equal(spawned[1].cwd, spawned[0].cwd, 'turn 2 runs in the same workspace');
    assert.equal(spawned[1].args[spawned[1].args.indexOf('--conversation') + 1], brainId);
    assert.deepEqual(created(second), [], 'a healthy resume announces nothing');
  });
}

test('a rejected handover (foreign participant on the brain) keeps the spawn key resumable', async () => {
  const dir = project('repo');
  spawned.length = 0;
  const brainId = randomUUID();
  nextBrainId = brainId;
  const stranger = userDb.createUser(`agy_stranger_${randomUUID()}`, 'hash', 'user');
  sessionsDb.createSession(brainId, 'antigravity', dir);
  getConnection().prepare(
    "INSERT INTO session_participants (session_id, user_id, role) VALUES (?, ?, 'owner')",
  ).run(brainId, stranger.id);

  const first = await turn(dir, null);
  assert.deepEqual(failures(first), []);
  const frames = created(first);
  assert.equal(frames.length, 1, 'no durable id is announced after a refusal');
  const spawnKey = String(frames[0].newSessionId);
  assert.ok(sessionsDb.getSessionById(spawnKey), 'adopt did not run: the stub stays');
  assert.deepEqual(ledger(spawnKey), [{ mode: 'overlay' }]);
  assert.deepEqual(ledger(brainId), []);

  const second = await turn(dir, spawnKey);
  assert.deepEqual(failures(second), [], JSON.stringify(second));
  assert.equal(spawned[1].cwd, spawned[0].cwd);
  assert.equal(spawned[1].args[spawned[1].args.indexOf('--conversation') + 1], brainId);
  assert.deepEqual(created(second), [], 'a resumed spawn key is never swapped outside its launch');
  assert.ok(sessionsDb.getSessionById(spawnKey), 'and never adopted without an accepted handover');
});

test('two concurrent fresh chats for the same user each hand over to their own brain', async () => {
  const dir = project('repo');
  spawned.length = 0;
  const [a, b] = await Promise.all([turn(dir, null), turn(dir, null)]);
  for (const frames of [a, b]) assert.deepEqual(failures(frames), [], JSON.stringify(frames));
  const pairs = [a, b].map((frames) => created(frames).map((frame) => String(frame.newSessionId)));
  assert.equal(pairs[0].length, 2);
  assert.equal(pairs[1].length, 2);
  assert.notEqual(pairs[0][1], pairs[1][1], 'distinct brains');
  assert.deepEqual(new Set([pairs[0][1], pairs[1][1]]), new Set(spawned.map((entry) => entry.brainId)));
  for (const [, brainId] of pairs) assert.deepEqual(ledger(brainId), [{ mode: 'overlay' }]);
});

test('the wrapper announces the handover once; replays drop, an undeclared identity fails closed', async () => {
  const dir = project('repo');
  const brainId = randomUUID();
  const received: Frame[] = [];
  const verdicts: unknown[] = [];
  const socket = { readyState: 1, userId: user.id, send: (frame: string) => received.push(JSON.parse(frame)) };
  const runtime = async (_command: string, _options: unknown, runWriter: Record<string, any>) => {
    const spawnKey = `agy_${Date.now()}_replay1`;
    runWriter.send({ kind: 'session_created', newSessionId: spawnKey, sessionId: spawnKey });
    const logs = path.join(brainRoot, brainId, '.system_generated', 'logs');
    fs.mkdirSync(logs, { recursive: true });
    sessionsDb.createSession(brainId, 'antigravity', dir, undefined, undefined, undefined,
      path.join(logs, 'transcript.jsonl'));
    const request = { from: spawnKey, to: brainId, spawnStartedAtMs: Date.now() - 1000 };
    verdicts.push(runWriter.requestSessionHandover(request));
    verdicts.push(runWriter.requestSessionHandover(request));
    const announce = { kind: 'session_created', newSessionId: brainId, sessionId: brainId, parentSessionId: spawnKey };
    runWriter.send(announce);
    runWriter.send(announce);
    runWriter.send({ kind: 'session_created', newSessionId: spawnKey, sessionId: spawnKey });
    runWriter.send({ kind: 'session_created', newSessionId: randomUUID(), sessionId: 'undeclared' });
    runWriter.send({ kind: 'text', content: 'after conflict', sessionId: brainId });
  };
  await dispatchProviderCommand(
    'antigravity-command',
    { type: 'antigravity-command', command: 'x', options: { cwd: dir, clientMsgId: `cmid-${randomUUID()}` } } as never,
    new WebSocketWriter(socket as never, user.id),
    { getSessionProvider: () => 'antigravity', authorizeProviderExecution: authorized, spawnAntigravity: runtime } as never,
    user.id,
    Object.freeze({ id: user.id, role: 'user', authenticationKind: 'session', authorizationGeneration: 1 }),
  );
  assert.deepEqual(verdicts.map((verdict) => (verdict as { reason: string }).reason), ['accepted', 'idempotent_repeat']);
  const announced = created(received);
  assert.equal(announced.length, 2, 'spawn key once, durable id once');
  assert.equal(announced[1].newSessionId, brainId);
  assert.ok(announced[1].workspaceGeneration, 'the rebound overlay generation rides along');
  assert.equal(received.some((frame) => frame.code === 'session_workspace_bind_failed'), true);
  assert.equal(received.some((frame) => frame.content === 'after conflict'), false);
  assert.deepEqual(ledger(brainId), [{ mode: 'overlay' }]);
});
