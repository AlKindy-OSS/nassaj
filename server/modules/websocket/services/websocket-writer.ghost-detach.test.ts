// ADR-042 (B-80c) listener-detection seam — unit tests for the read-only
// helpers the claude-sdk ghost sweep relies on: `countLiveMirrors` (live mirror
// count with dead-socket pruning) and `WebSocketWriter.isPrimarySocketAlive`.
// These two are the entire surface the sweep uses to decide "no listener"; the
// detach decision itself lives in claude-sdk.ghost-detach.test.ts.

import assert from 'node:assert/strict';
import test from 'node:test';

import { WS_OPEN_STATE } from './websocket-state.service.js';
import { addSessionMirror, countLiveMirrors, WebSocketWriter } from './websocket-writer.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

const WS_CLOSED = 3; // any value !== WS_OPEN_STATE counts as dead.

// Minimal RealtimeClientConnection double: only readyState/send are exercised.
function makeSocket(readyState: number): RealtimeClientConnection {
  return {
    readyState,
    send() {},
  } as unknown as RealtimeClientConnection;
}

test('countLiveMirrors returns 0 for a session with no registered mirrors', () => {
  assert.equal(countLiveMirrors('sid-none'), 0);
});

test('countLiveMirrors counts only OPEN mirrors and prunes the dead ones', () => {
  const sid = 'sid-mixed';
  const open1 = makeSocket(WS_OPEN_STATE);
  const open2 = makeSocket(WS_OPEN_STATE);
  const dead = makeSocket(WS_CLOSED);
  addSessionMirror(sid, open1);
  addSessionMirror(sid, dead);
  addSessionMirror(sid, open2);

  // Two live, one dead → 2, and the dead socket is pruned so a re-count is stable.
  assert.equal(countLiveMirrors(sid), 2);
  assert.equal(countLiveMirrors(sid), 2);
});

test('countLiveMirrors drops the session entry once every mirror is dead', () => {
  const sid = 'sid-alldead';
  const dead1 = makeSocket(WS_CLOSED);
  const dead2 = makeSocket(WS_CLOSED);
  addSessionMirror(sid, dead1);
  addSessionMirror(sid, dead2);

  assert.equal(countLiveMirrors(sid), 0);
  // Entry was deleted; a fresh registration starts clean (still counts correctly).
  const open = makeSocket(WS_OPEN_STATE);
  addSessionMirror(sid, open);
  assert.equal(countLiveMirrors(sid), 1);
});

test('isPrimarySocketAlive reflects readyState exactly (OPEN→true, otherwise→false)', () => {
  const openWriter = new WebSocketWriter(makeSocket(WS_OPEN_STATE));
  const closedWriter = new WebSocketWriter(makeSocket(WS_CLOSED));
  assert.equal(openWriter.isPrimarySocketAlive(), true);
  assert.equal(closedWriter.isPrimarySocketAlive(), false);
});

test('isPrimarySocketAlive is read-only — it never mutates or closes the socket', () => {
  const socket = makeSocket(WS_OPEN_STATE);
  const writer = new WebSocketWriter(socket);
  writer.isPrimarySocketAlive();
  // The socket object is untouched: same reference, same readyState.
  assert.equal(writer.ws, socket);
  assert.equal(socket.readyState, WS_OPEN_STATE);
});
