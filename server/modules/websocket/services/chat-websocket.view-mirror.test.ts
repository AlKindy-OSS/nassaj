// B-1666 #5 — one view mirror per socket. Drives the real `handleChatConnection`
// dispatcher and the real mirror registry: check-session-status moves a socket's
// mirror to the session now on screen instead of accumulating every session the
// tab ever opened; returning to an earlier session replays seq > lastSeq
// (claude, antigravity) and mirrors it live again; other sockets are untouched.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test, { after } from 'node:test';

import { initializeDatabase, sessionsDb } from '@/modules/database/index.js';

import { handleChatConnection } from './chat-websocket.service.js';
import { __mirroredSessionCountForTests, removeSessionMirrorsForSocket, WebSocketWriter } from './websocket-writer.service.js';

await initializeDatabase();

// See chat-websocket.attach.test.ts: a non-hidden root outside the home.
const PROJECT_PATH = fs.mkdtempSync('/var/tmp/chat-view-mirror-project-');
after(() => fs.rmSync(PROJECT_PATH, { recursive: true, force: true }));

function makeReplay() {
  const items: { seq: number; payload: unknown }[] = [];
  return {
    record(payload: unknown) { items.push({ seq: items.length + 1, payload }); },
    attach(lastSeq: number, send: (p: unknown) => void) {
      for (const item of items) if (item.seq > lastSeq) send(item.payload);
      return items.length;
    },
  };
}

function makeFakeWs() {
  const sent: any[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: 1,
    sent,
    send(data: string) { sent.push(JSON.parse(data)); },
    on(event: string, cb: (arg: unknown) => void) { (listeners[event] ||= []).push(cb); },
    emit(event: string, arg: unknown) { (listeners[event] || []).forEach((cb) => cb(arg)); },
  };
}

type Provider = 'claude' | 'antigravity';

function makeDeps(provider: Provider, replays: Map<string, ReturnType<typeof makeReplay>>) {
  const attach = (sessionId: string, lastSeq: number, send: (p: unknown) => void) =>
    replays.get(sessionId)?.attach(lastSeq, send) ?? lastSeq;
  return {
    queryClaudeSDK: async () => {}, spawnCursor: async () => {}, queryCodex: async () => {},
    spawnAntigravity: async () => {}, spawnOpenCode: async () => {}, getSessionProvider: () => null,
    abortClaudeSDKSession: async () => false, abortCursorSession: () => false, abortCodexSession: () => false,
    abortAntigravitySession: () => false, abortOpenCodeSession: () => false, resolveToolApproval: () => {},
    isClaudeSDKSessionActive: () => provider === 'claude', isCursorSessionActive: () => false,
    isCodexSessionActive: () => false, isAntigravitySessionActive: () => provider === 'antigravity',
    isOpenCodeSessionActive: () => false,
    reconnectSessionWriter: () => assert.fail('a live run with a live primary must never be swapped'),
    attachAntigravitySession: attach, attachClaudeSDKSession: attach,
    getPendingApprovalsForSession: () => [], getActiveClaudeSDKSessions: () => [],
    getActiveCursorSessions: () => [], getActiveCodexSessions: () => [],
    getActiveAntigravitySessions: () => [], getActiveOpenCodeSessions: () => [],
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

function view(ws: ReturnType<typeof makeFakeWs>, provider: Provider, sessionId: string, lastSeq = 0) {
  ws.emit('message', JSON.stringify({ type: 'check-session-status', provider, sessionId, lastSeq }));
}

const contents = (ws: ReturnType<typeof makeFakeWs>) => ws.sent.map((m) => m.content).filter(Boolean);

for (const provider of ['claude', 'antigravity'] as const) {
  test(`${provider}: the mirror follows the viewed session; returning replays then mirrors again`, () => {
    const A = `${provider}-view-A`;
    const B = `${provider}-view-B`;
    sessionsDb.createSession(A, provider, PROJECT_PATH);
    sessionsDb.createSession(B, provider, PROJECT_PATH);
    const replays = new Map([[A, makeReplay()], [B, makeReplay()]]);
    replays.get(A)!.record({ kind: 'text', role: 'assistant', sessionId: A, content: 'a-1', sequence: 1 });

    const viewer = makeFakeWs();
    handleChatConnection(viewer as any, { user: { id: 1 } } as any, makeDeps(provider, replays));
    const runOwner = new WebSocketWriter(makeFakeWs() as never, 2);
    const before = __mirroredSessionCountForTests();

    view(viewer, provider, A);
    view(viewer, provider, B);
    runOwner.send({ kind: 'text', role: 'assistant', sessionId: A, content: 'a-live-hidden' });
    runOwner.send({ kind: 'text', role: 'assistant', sessionId: B, content: 'b-live' });
    assert.ok(!contents(viewer).includes('a-live-hidden'), 'a session left behind no longer streams here');
    assert.ok(contents(viewer).includes('b-live'), 'the viewed session streams live');

    replays.get(A)!.record({ kind: 'text', role: 'assistant', sessionId: A, content: 'a-2', sequence: 2 });
    view(viewer, provider, A, 1);
    runOwner.send({ kind: 'text', role: 'assistant', sessionId: A, content: 'a-live-again' });
    assert.deepEqual(contents(viewer).filter((c) => c.startsWith('a-')), ['a-1', 'a-2', 'a-live-again'],
      'first view replays a-1, the return replays only seq > lastSeq, then the live mirror resumes');
    assert.equal(__mirroredSessionCountForTests(), before + 1, 'one view mirror for this socket');

    removeSessionMirrorsForSocket(viewer as never);
    assert.equal(__mirroredSessionCountForTests(), before);
  });
}

test('multi-viewer: two sockets viewing the same session both stay mirrored', () => {
  const S = 'claude-view-shared';
  const other = 'claude-view-other';
  sessionsDb.createSession(S, 'claude', PROJECT_PATH);
  sessionsDb.createSession(other, 'claude', PROJECT_PATH);
  const replays = new Map([[S, makeReplay()], [other, makeReplay()]]);
  const first = makeFakeWs();
  const second = makeFakeWs();
  handleChatConnection(first as any, { user: { id: 1 } } as any, makeDeps('claude', replays));
  handleChatConnection(second as any, { user: { id: 3 } } as any, makeDeps('claude', replays));

  view(first, 'claude', S);
  view(second, 'claude', other);
  view(second, 'claude', S); // the second viewer moving onto S must not evict the first
  new WebSocketWriter(makeFakeWs() as never, 2).send({ kind: 'text', role: 'assistant', sessionId: S, content: 'shared' });

  assert.ok(contents(first).includes('shared'));
  assert.ok(contents(second).includes('shared'));
  removeSessionMirrorsForSocket(first as never);
  removeSessionMirrorsForSocket(second as never);
});
