/** ADR-187 behavioural tests: authorization, storage atomicity and reconnect safety. */
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  closeConnection, getConnection, initializeDatabase, sessionsDb, stopReconcileScheduler, userDb,
} from '@/modules/database/index.js';
import { isSessionAccessibleByUser } from '@/modules/providers/index.js';

import { configureInternalChatSessionAccess } from './access.js';
import { handleInternalChatConnection } from './connection.js';
import { internalChatRealtime } from './realtime.js';
import { internalSessionChatDb } from './repository.js';
import { createInternalSessionChatRouter } from './routes.js';

let projectPath = '';

const recorder = () => {
  const frames: string[] = [];
  return { frames, socket: { readyState: 1, send: (frame: string) => frames.push(frame) } };
};
const frameTypes = (frames: string[]) => frames.map(frame => JSON.parse(frame).type);

async function withDatabase(run: () => void | Promise<void>) {
  const previous = process.env.DATABASE_PATH;
  const directory = await mkdtemp(path.join(tmpdir(), 'internal-session-chat-'));
  closeConnection();
  process.env.DATABASE_PATH = path.join(directory, 'auth.db');
  process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = '1';
  projectPath = await mkdir(path.join(directory, 'project'), { recursive: true }).then(() => path.join(directory, 'project'));
  await initializeDatabase();
  stopReconcileScheduler();
  // The same platform predicate server/index.js injects.
  configureInternalChatSessionAccess(isSessionAccessibleByUser);
  try { await run(); } finally {
    configureInternalChatSessionAccess(null);
    delete process.env.PROJECT_MEMBERSHIP_ENFORCE;
    delete process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED;
    closeConnection();
    if (previous === undefined) delete process.env.DATABASE_PATH; else process.env.DATABASE_PATH = previous;
    await rm(directory, { recursive: true, force: true });
  }
}

function seed() {
  const db = getConnection();
  for (const [id, username] of [[1, 'owner'], [2, 'member'], [3, 'outsider']]) {
    db.prepare("INSERT INTO users(id,username,password_hash) VALUES(?,?,'test-hash')").run(id, username);
  }
  sessionsDb.createSession('room', 'claude', projectPath);
  const { project_id: projectId } = db.prepare('SELECT project_id FROM sessions s JOIN projects p ON p.project_path=s.project_path WHERE s.session_id=?')
    .get('room') as { project_id: string };
  // Owner and member belong to the project; user 3 is outside it.
  for (const userId of [1, 2]) db.prepare('INSERT INTO project_members(project_id,user_id) VALUES(?,?)').run(projectId, userId);
  db.prepare("INSERT INTO session_participants(session_id,user_id,role,attribution) VALUES('room',1,'owner','spawn')").run();
  assert.ok(internalSessionChatDb.createRoom('room', 1));
  assert.equal(internalSessionChatDb.addMember('room', 1, 2, 'member'), true);
}

async function serverFor(userId: number, options: Parameters<typeof createInternalSessionChatRouter>[0] = {}) {
  const app = express(); app.use(express.json());
  app.use((req: any, _res, next) => { req.user = { id: userId }; next(); });
  app.use('/api/sessions', createInternalSessionChatRouter(options));
  const server = await new Promise<any>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  const address = server.address();
  return { base: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>(resolve => server.close(() => resolve())) };
}

test('IDOR returns the same 404 for an outsider, a missing room, and a missing session', async () => {
  await withDatabase(async () => {
    seed();
    const api = await serverFor(3);
    try {
      const responses = await Promise.all([
        fetch(`${api.base}/api/sessions/room/internal-room`),
        fetch(`${api.base}/api/sessions/missing/internal-room`),
        fetch(`${api.base}/api/sessions/room/internal-messages`),
      ]);
      for (const response of responses) {
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'Not found' });
      }
    } finally { await api.close(); }
  });
});

test('sequence allocation, idempotency and read watermark remain correct across retries', async () => {
  await withDatabase(() => {
    seed();
    assert.deepEqual((internalSessionChatDb.roomFor('room', 1) as any).members.map((member: any) => member.username), ['owner', 'member']);
    const first = internalSessionChatDb.send('room', 1, 'first', 'client-1', [2]);
    const retry = internalSessionChatDb.send('room', 1, 'first', 'client-1', [2]);
    const second = internalSessionChatDb.send('room', 1, 'second', 'client-2', []);
    assert.equal(first.kind, 'created'); assert.equal(retry.kind, 'existing'); assert.equal(second.kind, 'created');
    assert.equal((first as any).message.sequence, 1); assert.equal((retry as any).message.sequence, 1); assert.equal((second as any).message.sequence, 2);
    assert.equal(internalSessionChatDb.send('room', 1, 'changed', 'client-1', [2]).kind, 'conflict');
    assert.equal((internalSessionChatDb.markRead('room', 2, 2) as any).lastReadSequence, 2);
    assert.equal((internalSessionChatDb.markRead('room', 2, 1) as any).lastReadSequence, 2, 'delayed read cannot regress the watermark');
    assert.equal(internalSessionChatDb.markRead('room', 2, 3), undefined, 'a read past the committed sequence fails closed');
  });
});

test('non-active rooms return uniform 404 and revalidation replaces members atomically', async () => {
  await withDatabase(async () => {
    seed();
    const db = getConnection();
    const revokedFrames: string[] = [];
    const removedSocket = { readyState: 1, send: (frame: string) => revokedFrames.push(frame) };
    assert.equal(internalChatRealtime.subscribe('room', 2, removedSocket), true);
    db.prepare("UPDATE session_internal_rooms SET membership_state='revalidation_required' WHERE session_id='room'").run();
    const owner = await serverFor(1), removed = await serverFor(2), replacement = await serverFor(3);
    try {
      for (const url of [
        `${owner.base}/api/sessions/room/internal-room`,
        `${owner.base}/api/sessions/room/internal-messages`,
        `${owner.base}/api/sessions/room/internal-read`,
      ]) {
        const response = url.endsWith('internal-read')
          ? await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sequence: 0 }) })
          : await fetch(url);
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'Not found' });
      }
      const revalidated = await fetch(`${owner.base}/api/sessions/room/internal-room/revalidate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ members: [{ userId: 1, role: 'owner' }, { userId: 3, role: 'member' }] }),
      });
      assert.equal(revalidated.status, 200);
      assert.deepEqual((await revalidated.json()).members.map((member: any) => member.userId), [1, 3]);
      assert.equal((await fetch(`${removed.base}/api/sessions/room/internal-room`)).status, 404);
      assert.equal((await fetch(`${replacement.base}/api/sessions/room/internal-room`)).status, 200);
      assert.deepEqual(revokedFrames.map(frame => JSON.parse(frame)), [{ type: 'internal-chat.membership_revoked', sessionId: 'room' }]);
    } finally {
      internalChatRealtime.unsubscribe(removedSocket);
      await Promise.all([owner.close(), removed.close(), replacement.close()]);
    }
  });
});

test('a project transfer invalidates every prior member until explicit revalidation', async () => {
  await withDatabase(() => {
    seed();
    const live = recorder();
    assert.equal(internalChatRealtime.subscribe('room', 2, live.socket), true);
    sessionsDb.createSession('room', 'claude', '/project-after-transfer');
    assert.deepEqual(frameTypes(live.frames), ['internal-chat.membership_revoked'], 'transfer ends live subscriptions');
    internalChatRealtime.unsubscribe(live.socket);
    assert.equal(internalSessionChatDb.roomFor('room', 1), undefined);
    assert.equal(internalSessionChatDb.roomFor('room', 2), undefined);
    assert.equal(internalSessionChatDb.send('room', 1, 'must fail', 'transferred-1', []).kind, 'missing');
    assert.equal(internalSessionChatDb.list('room', 2, undefined, 10), undefined);
  });
});

test('a created mention publishes only the recipient mention-state frame', async () => {
  await withDatabase(async () => {
    seed();
    const calls: Array<[string, number, number, number]> = [];
    const original = internalChatRealtime.publishMentionState;
    internalChatRealtime.publishMentionState = ((sessionId, userId, count, version) => calls.push([sessionId, userId, count, version])) as typeof original;
    const api = await serverFor(1);
    try {
      const response = await fetch(`${api.base}/api/sessions/room/internal-messages`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: '@member hello', clientMessageId: 'mention-1', mentionUserIds: [2] }),
      });
      assert.equal(response.status, 201);
      assert.deepEqual(calls, [['room', 2, 1, 3]]);
    } finally {
      internalChatRealtime.publishMentionState = original;
      await api.close();
    }
  });
});

test('real session deletion cascades the room, memberships, messages and mentions with foreign keys enabled', async () => {
  await withDatabase(() => {
    seed();
    assert.equal(internalSessionChatDb.send('room', 1, 'private', 'cascade-1', [2]).kind, 'created');
    const db = getConnection(); db.pragma('foreign_keys = ON');
    assert.equal(sessionsDb.deleteSessionById('room'), true);
    for (const table of ['session_internal_rooms', 'session_internal_room_members', 'session_internal_messages', 'session_internal_message_mentions']) {
      assert.equal((db.prepare(`SELECT count(*) count FROM ${table}`).get() as any).count, 0, `${table} must cascade`);
    }
  });
});

test('internal storage remains separate from provider transcript and coordination tables', async () => {
  await withDatabase(() => {
    seed();
    assert.equal(internalSessionChatDb.send('room', 1, 'never a prompt', 'isolation-1', [2]).kind, 'created');
    const db = getConnection();
    for (const table of ['message_coordination_ingress', 'message_authors']) {
      assert.equal((db.prepare(`SELECT count(*) count FROM ${table} WHERE session_id='room'`).get() as any).count, 0, `${table} must not receive internal content`);
    }
  });
});

test('an unconfigured session predicate fails closed for every member', async () => {
  await withDatabase(() => {
    seed();
    configureInternalChatSessionAccess(null);
    assert.equal(internalSessionChatDb.roomFor('room', 1), undefined);
    assert.equal(internalSessionChatDb.send('room', 1, 'x', 'closed-1', []).kind, 'missing');
  });
});

test('ADR-172 enforcement: non-members cannot be granted and removed members lose reads and frames', async () => {
  await withDatabase(async () => {
    seed();
    process.env.PROJECT_MEMBERSHIP_ENFORCE = '1';
    const db = getConnection();
    assert.equal(internalSessionChatDb.addMember('room', 1, 3, 'member'), false, 'outsider is never granted');
    assert.equal(internalSessionChatDb.revalidateRoom('room', 1, [
      { userId: 1, role: 'owner' }, { userId: 3, role: 'member' },
    ]), undefined, 'revalidation cannot smuggle an outsider in');
    const member = recorder();
    try {
      assert.equal(internalChatRealtime.subscribe('room', 2, member.socket), true);
      db.prepare('DELETE FROM project_members WHERE user_id=2').run();
      assert.equal(internalSessionChatDb.roomFor('room', 2), undefined);
      assert.equal(internalSessionChatDb.list('room', 2, undefined, 10), undefined);
      assert.equal(internalSessionChatDb.send('room', 2, 'late', 'late-1', []).kind, 'missing');
      assert.equal(internalSessionChatDb.send('room', 1, '@member', 'm-1', [2]).kind, 'missing',
        'a member without project access cannot be mentioned');
      internalChatRealtime.publishMessage('room', { body: 'must-not-deliver' });
      assert.deepEqual(frameTypes(member.frames), ['internal-chat.membership_revoked']);
      const api = await serverFor(2);
      try {
        assert.equal((await fetch(`${api.base}/api/sessions/room/internal-messages`)).status, 404);
      } finally { await api.close(); }
    } finally {
      internalChatRealtime.unsubscribe(member.socket);
    }
  });
});

test('project membership removal drops only the removed user\'s live room subscriptions', async () => {
  await withDatabase(() => {
    seed();
    const member = recorder();
    const owner = recorder();
    try {
      internalChatRealtime.subscribe('room', 2, member.socket);
      internalChatRealtime.subscribe('room', 1, owner.socket);
      assert.equal(internalChatRealtime.revokeUserSessions(2, ['room', 'other']), 1);
      internalChatRealtime.publishMessage('room', { body: 'after removal' });
      assert.deepEqual(frameTypes(member.frames), ['internal-chat.membership_revoked']);
      assert.deepEqual(frameTypes(owner.frames), ['internal-chat.message.created']);
    } finally {
      internalChatRealtime.unsubscribe(member.socket);
      internalChatRealtime.unsubscribe(owner.socket);
    }
  });
});

test('a disabled account loses room access and live delivery immediately', async () => {
  await withDatabase(() => {
    seed();
    const member = recorder();
    try {
      assert.equal(internalChatRealtime.subscribe('room', 2, member.socket), true);
      userDb.setStatus(2, 'disabled');
      assert.equal(internalSessionChatDb.roomFor('room', 2), undefined);
      assert.equal(internalSessionChatDb.send('room', 2, 'x', 'disabled-1', []).kind, 'missing');
      internalChatRealtime.publishMessage('room', { body: 'must-not-deliver' });
      assert.deepEqual(frameTypes(member.frames), ['internal-chat.membership_revoked']);
      assert.equal(internalChatRealtime.subscribe('room', 2, recorder().socket), false);
      const members = (internalSessionChatDb.roomFor('room', 1) as any).members.map((row: any) => row.userId);
      assert.deepEqual(members, [1], 'a disabled account is not offered as a mention target');
    } finally { internalChatRealtime.unsubscribe(member.socket); }
  });
});

test('deleting an account that authored, created or granted is not blocked by the chat tables', async () => {
  await withDatabase(() => {
    seed();
    const db = getConnection();
    assert.equal(internalSessionChatDb.send('room', 2, 'from member', 'author-1', [1]).kind, 'created');
    assert.equal(internalSessionChatDb.send('room', 1, 'from owner', 'author-2', [2]).kind, 'created');
    assert.equal(userDb.deleteUser(2), true);
    assert.equal(userDb.deleteUser(1), true, 'room creator and granter can be deleted');
    const authors = db.prepare('SELECT author_user_id a FROM session_internal_messages ORDER BY sequence').all();
    assert.deepEqual(authors, [{ a: null }, { a: null }]);
    assert.equal((db.prepare('SELECT count(*) n FROM session_internal_room_members').get() as any).n, 0);
    assert.equal((db.prepare('SELECT created_by c FROM session_internal_rooms').get() as any).c, null);
  });
});

const json = (body: unknown, method = 'POST') => ({
  method, headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
});
const MESSAGE_DTO_KEYS = ['authorName', 'authorUserId', 'body', 'clientMessageId', 'createdAt', 'editedAt', 'id', 'sequence'];

test('send, list and broadcast share one camelCase DTO with the author name and no fingerprint', async () => {
  await withDatabase(async () => {
    seed();
    const member = recorder();
    const api = await serverFor(1);
    try {
      internalChatRealtime.subscribe('room', 2, member.socket);
      const sent = await fetch(`${api.base}/api/sessions/room/internal-messages`, json({ body: 'hello', clientMessageId: 'dto-1' }));
      assert.equal(sent.status, 201);
      const created = await sent.json();
      assert.deepEqual(Object.keys(created).sort(), MESSAGE_DTO_KEYS);
      assert.equal(created.authorName, 'owner');
      const retried = await (await fetch(`${api.base}/api/sessions/room/internal-messages`, json({ body: 'hello', clientMessageId: 'dto-1' }))).json();
      assert.deepEqual(retried, created, 'an idempotent retry returns the same DTO');
      const listed = await (await fetch(`${api.base}/api/sessions/room/internal-messages`)).json();
      assert.deepEqual(listed.messages[0], created);
      assert.deepEqual(JSON.parse(member.frames[0]).message, created);
      assert.equal(member.frames.join('').includes('request_fingerprint'), false);
    } finally {
      internalChatRealtime.unsubscribe(member.socket);
      await api.close();
    }
  });
});

test('enabled HTTP validation refuses malformed input with the uniform 404', async () => {
  await withDatabase(async () => {
    seed();
    const api = await serverFor(1);
    const url = (suffix: string) => `${api.base}/api/sessions/room/${suffix}`;
    try {
      const refused = [
        await fetch(url('internal-messages'), json({ body: '   ', clientMessageId: 'v-1' })),
        await fetch(url('internal-messages'), json({ body: 'x'.repeat(8001), clientMessageId: 'v-2' })),
        await fetch(url('internal-messages'), json({ body: 'x', clientMessageId: 'bad id' })),
        await fetch(url('internal-messages'), json({ body: 'x', clientMessageId: 'v-3', mentionUserIds: ['2'] })),
        await fetch(url('internal-messages'), json({ body: 'x', clientMessageId: 'v-4', mentionUserIds: Array(51).fill(2) })),
        await fetch(url('internal-messages?beforeSequence=0')),
        await fetch(url('internal-room/members'), json({ userId: 3, role: 'owner' })),
        await fetch(url('internal-room/revalidate'), json({ members: [{ userId: 1, role: 'admin' }] })),
        await fetch(url('internal-read'), json({ sequence: '1' })),
        await fetch(url('internal-room/members/abc'), { method: 'DELETE' }),
      ];
      for (const response of refused) {
        assert.equal(response.status, 404);
        assert.deepEqual(await response.json(), { error: 'Not found' });
      }
    } finally { await api.close(); }
  });
});

test('the sessionId param check refuses before the readiness gate or any repository call', async () => {
  await withDatabase(async () => {
    seed();
    const original = internalSessionChatDb.roomFor;
    let calls = 0;
    (internalSessionChatDb as any).roomFor = (...args: [string, number]) => { calls += 1; return original.apply(internalSessionChatDb, args); };
    const api = await serverFor(1);
    try {
      const invalid = await fetch(`${api.base}/api/sessions/bad%20id/internal-room`);
      assert.equal(invalid.status, 404);
      assert.equal(calls, 0);
      process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = '0';
      assert.equal((await fetch(`${api.base}/api/sessions/room/internal-room`)).status, 404);
      assert.equal(calls, 0, 'the gate refuses before the repository when the flag is off');
    } finally {
      process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = '1';
      (internalSessionChatDb as any).roomFor = original;
      await api.close();
    }
  });
});

test('write routes pass through the injected rate limiter and reads do not', async () => {
  await withDatabase(async () => {
    seed();
    const limited: string[] = [];
    const api = await serverFor(1, {
      writeLimiter: (req, res) => { limited.push(`${req.method} ${req.path}`); res.status(429).json({ error: 'slow' }); },
    });
    try {
      assert.equal((await fetch(`${api.base}/api/sessions/room/internal-room`)).status, 200);
      assert.equal((await fetch(`${api.base}/api/sessions/room/internal-messages`)).status, 200);
      for (const [suffix, body, method] of [
        ['internal-room', {}, 'POST'],
        ['internal-room/revalidate', { members: [{ userId: 1, role: 'owner' }] }, 'POST'],
        ['internal-room/members', { userId: 3, role: 'member' }, 'POST'],
        ['internal-room/members/2', undefined, 'DELETE'],
        ['internal-messages', { body: 'x', clientMessageId: 'rl-1' }, 'POST'],
      ] as const) {
        const response = await fetch(`${api.base}/api/sessions/room/${suffix}`, body ? json(body, method) : { method });
        assert.equal(response.status, 429, suffix);
      }
      assert.equal(limited.length, 5);
    } finally { await api.close(); }
  });
});

test('room creation and member changes are audited with ids only, never message text', async () => {
  await withDatabase(async () => {
    seed();
    const db = getConnection();
    db.prepare("INSERT INTO sessions(session_id,provider,project_path) VALUES('room2','claude',?)").run(projectPath);
    db.prepare("INSERT INTO session_participants(session_id,user_id,role,attribution) VALUES('room2',1,'owner','spawn')").run();
    const api = await serverFor(1);
    try {
      assert.equal((await fetch(`${api.base}/api/sessions/room2/internal-room`, json({}))).status, 201);
      assert.equal((await fetch(`${api.base}/api/sessions/room2/internal-room`, json({}))).status, 200);
      assert.equal((await fetch(`${api.base}/api/sessions/room/internal-room/members`, json({ userId: 3, role: 'viewer' }))).status, 201);
      assert.equal((await fetch(`${api.base}/api/sessions/room/internal-room/members/3`, { method: 'DELETE' })).status, 204);
      await fetch(`${api.base}/api/sessions/room/internal-messages`, json({ body: 'secret words', clientMessageId: 'a-1' }));
      const rows = db.prepare("SELECT action, metadata FROM audit_log WHERE action LIKE 'internal_chat_%' ORDER BY id").all() as any[];
      assert.deepEqual(rows.map(row => row.action), [
        'internal_chat_room_created', 'internal_chat_member_added', 'internal_chat_member_removed',
      ]);
      assert.deepEqual(JSON.parse(rows[1].metadata), { sessionId: 'room', targetUserId: 3, role: 'viewer' });
      assert.equal(JSON.stringify(rows).includes('secret'), false);
    } finally { await api.close(); }
  });
});

/** Minimal ws stand-in: records close codes and the registered close listener. */
const fakeConnection = () => {
  const frames: string[] = [];
  const closes: number[] = [];
  let onClose: (() => void) | null = null;
  return {
    frames, closes, fireClose: () => onClose?.(),
    socket: {
      readyState: 1,
      send: (frame: string) => frames.push(frame),
      close: (code?: number) => { closes.push(code ?? 1000); },
      on: (_event: 'close', listener: () => void) => { onClose = listener; },
    },
  };
};

test('WS /internal-session-chat: flag off and non-members close terminally; members unsubscribe on close', async () => {
  await withDatabase(async () => {
    seed();
    const outsider = fakeConnection();
    assert.equal(handleInternalChatConnection(outsider.socket, '/internal-session-chat?sessionId=room', 3), false);
    assert.deepEqual(outsider.closes, [4404]);
    const noSession = fakeConnection();
    assert.equal(handleInternalChatConnection(noSession.socket, '/internal-session-chat', 1), false);
    assert.deepEqual(noSession.closes, [4404]);

    const member = fakeConnection();
    assert.equal(handleInternalChatConnection(member.socket, '/internal-session-chat?sessionId=room', 2), true);
    internalChatRealtime.publishMessage('room', { body: 'first' });
    member.fireClose();
    internalChatRealtime.publishMessage('room', { body: 'after close' });
    assert.equal(member.frames.length, 1, 'no frame after the socket closed');

    process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = '0';
    const disabled = fakeConnection();
    try {
      assert.equal(handleInternalChatConnection(disabled.socket, '/internal-session-chat?sessionId=room', 1), false);
      assert.deepEqual(disabled.closes, [4404]);
    } finally { process.env.NASSAJ_INTERNAL_SESSION_CHAT_ENABLED = '1'; }
  });
});

test('a revoked subscriber receives the revocation frame and a terminal close', async () => {
  await withDatabase(() => {
    seed();
    const member = fakeConnection();
    handleInternalChatConnection(member.socket, '/internal-session-chat?sessionId=room', 2);
    internalChatRealtime.revoke('room', 2);
    assert.deepEqual(frameTypes(member.frames), ['internal-chat.membership_revoked']);
    assert.deepEqual(member.closes, [4404]);
  });
});

test('the disabled feature never shadows sibling /api/sessions routes', async () => {
  const app = express();
  app.use('/api/sessions', createInternalSessionChatRouter());
  app.get('/api/sessions/:sessionId/participants', (_req, res) => { res.json({ ok: true }); });
  const server = await new Promise<any>(resolve => { const value = app.listen(0, '127.0.0.1', () => resolve(value)); });
  try {
    const base = `http://127.0.0.1:${server.address().port}`;
    assert.equal((await fetch(`${base}/api/sessions/room/participants`)).status, 200);
    assert.equal((await fetch(`${base}/api/sessions/room/internal-room`)).status, 404);
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
