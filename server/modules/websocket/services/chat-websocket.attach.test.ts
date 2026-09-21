// PHASE-SR-0 B-N-ATTACH integration test (ADR-021). Drives the real
// `handleChatConnection` dispatcher to prove the antigravity check-session-status
// path performs read-only differential replay WITHOUT swapping the writer and
// WITHOUT aborting the live session — honouring the documented `if(!isActive)`
// veto (regression 56d67f3 must stay fixed).

import assert from 'node:assert/strict';
import test from 'node:test';

import { handleChatConnection } from './chat-websocket.service.js';

// Inline replay double mirroring the SessionRegistry attach contract (seq>lastSeq,
// read-only). The real registry internals are covered by session-registry.test.ts;
// this integration test verifies only the service dispatch (no swap / no abort /
// differential pass-through), so it stays inside the websocket module boundary.
function makeReplayDouble() {
  const items: { seq: number; payload: unknown }[] = [];
  let active = false;
  return {
    open() {
      active = true;
    },
    record(payload: unknown) {
      items.push({ seq: items.length + 1, payload });
    },
    isActive() {
      return active;
    },
    attach(lastSeq: number, send: (p: unknown) => void) {
      let highest = lastSeq;
      for (const it of items) {
        if (it.seq > lastSeq) {
          send(it.payload);
          if (it.seq > highest) highest = it.seq;
        }
      }
      return highest;
    },
  };
}

const WS_OPEN_STATE = 1;

// Minimal raw-socket double matching the surface handleChatConnection touches.
function makeFakeWs() {
  const sent: any[] = [];
  const listeners: Record<string, ((arg: unknown) => void)[]> = {};
  return {
    readyState: WS_OPEN_STATE,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
    on(event: string, cb: (arg: unknown) => void) {
      (listeners[event] ||= []).push(cb);
    },
    emit(event: string, arg: unknown) {
      (listeners[event] || []).forEach((cb) => cb(arg));
    },
  };
}

// Build a full deps object; any function that must NOT be called on this path
// fails the test loudly if invoked.
function makeDeps(overrides: Record<string, unknown>) {
  const forbidden = (name: string) => () => {
    assert.fail(`${name} must not be called on the antigravity attach path`);
  };
  return {
    queryClaudeSDK: async () => {},
    spawnCursor: async () => {},
    queryCodex: async () => {},
    spawnGemini: async () => {},
    spawnAntigravity: async () => {},
    spawnOpenCode: async () => {},
    getSessionProvider: () => null,
    abortClaudeSDKSession: async () => false,
    abortCursorSession: () => false,
    abortCodexSession: () => false,
    abortGeminiSession: () => false,
    abortAntigravitySession: forbidden('abortAntigravitySession'),
    abortOpenCodeSession: () => false,
    resolveToolApproval: () => {},
    isClaudeSDKSessionActive: () => false,
    isCursorSessionActive: () => false,
    isCodexSessionActive: () => false,
    isGeminiSessionActive: () => false,
    isAntigravitySessionActive: () => true,
    isOpenCodeSessionActive: () => false,
    reconnectSessionWriter: forbidden('reconnectSessionWriter'),
    attachAntigravitySession: () => 0,
    // ADR-041 (B-80): the claude check-session-status branch now calls this
    // unconditionally (read-only replay, no-op when the flag is off), so the
    // fixture must provide it just as it does attachAntigravitySession. Without
    // it the dispatcher throws on the claude idle path below and the writer swap
    // never runs.
    attachClaudeSDKSession: () => 0,
    getPendingApprovalsForSession: () => [],
    getActiveClaudeSDKSessions: () => [],
    getActiveCursorSessions: () => [],
    getActiveCodexSessions: () => [],
    getActiveGeminiSessions: () => [],
    getActiveAntigravitySessions: () => [],
    getActiveOpenCodeSessions: () => [],
    ...overrides,
  } as unknown as Parameters<typeof handleChatConnection>[2];
}

test('B-N-ATTACH: check-session-status replays seq>lastSeq to the reconnecting socket without swap/abort', () => {
  // A live agy session with 4 buffered payloads.
  const reg = makeReplayDouble();
  const sid = 'agy-live-1';
  reg.open();
  for (let i = 1; i <= 4; i += 1) {
    reg.record({ kind: 'stream_delta', content: `m${i}`, provider: 'antigravity' });
  }

  const ws = makeFakeWs();
  const deps = makeDeps({
    isAntigravitySessionActive: () => reg.isActive(),
    attachAntigravitySession: (_s: string, lastSeq: number, send: (p: unknown) => void) =>
      reg.attach(lastSeq, send),
  });

  handleChatConnection(ws as any, { user: { id: 1 } } as any, deps);

  // Reconnecting client reports it last saw seq 2.
  ws.emit(
    'message',
    JSON.stringify({
      type: 'check-session-status',
      provider: 'antigravity',
      sessionId: sid,
      lastSeq: 2,
    })
  );

  const replayed = ws.sent.filter((m: any) => m.kind === 'stream_delta');
  assert.deepEqual(
    replayed.map((m: any) => m.content),
    ['m3', 'm4'],
    'only seq>lastSeq replayed — no duplicate, no gap'
  );

  const status = ws.sent.find((m: any) => m.type === 'session-status');
  assert.ok(status, 'session-status still returned');
  assert.equal(status.isProcessing, true, 'live session reported active');

  // The session remains active (never aborted). reconnectSessionWriter / abort
  // would have thrown via the forbidden() stubs if the path called them.
  assert.equal(reg.isActive(), true);
});

test('B-N-ATTACH: claude path is unchanged — idle claude still swaps writer', () => {
  let swapped = false;
  const ws = makeFakeWs();
  const deps = makeDeps({
    isClaudeSDKSessionActive: () => false, // idle
    reconnectSessionWriter: () => {
      swapped = true;
      return true;
    },
  });

  handleChatConnection(ws as any, { user: { id: 1 } } as any, deps);
  ws.emit(
    'message',
    JSON.stringify({ type: 'check-session-status', provider: 'claude', sessionId: 'c-1' })
  );

  assert.equal(swapped, true, 'claude idle path still calls reconnectSessionWriter (no regression)');
});
