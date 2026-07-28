// Open-sessions counter tests: unique-sessionId counting (start/stop/dedupe)
// and the WS broadcast contract — initial value per new socket, change-only
// broadcasts to every open client via the existing connectedClients set.

import assert from 'node:assert/strict';
import { afterEach, beforeEach, test } from 'node:test';

import {
  OPEN_SESSIONS_MESSAGE_TYPE,
  openSessionsCount,
  openSessionStarted,
  openSessionStopped,
  resetOpenSessionsForTest,
  sendOpenSessionsCount,
} from './open-sessions.service.js';
import {
  WS_OPEN_STATE,
  connectedClients,
} from './websocket-state.service.js';
import type { RealtimeClientConnection } from '@/shared/types.js';

type FakeClient = RealtimeClientConnection & { sent: { type: string; count: number; timestamp: string }[] };

function makeFakeClient(readyState: number = WS_OPEN_STATE): FakeClient {
  const sent: FakeClient['sent'] = [];
  return {
    readyState,
    sent,
    send(data: string) {
      sent.push(JSON.parse(data));
    },
  };
}

// connectedClients is shared module state — track the fakes this file adds so
// each test leaves the set exactly as it found it (parallel suites touch it).
const addedClients = new Set<RealtimeClientConnection>();

function attachClient(client: FakeClient): FakeClient {
  connectedClients.add(client);
  addedClients.add(client);
  return client;
}

beforeEach(() => {
  resetOpenSessionsForTest();
});

afterEach(() => {
  for (const client of addedClients) {
    connectedClients.delete(client);
  }
  addedClients.clear();
  resetOpenSessionsForTest();
});

// --- counting ---------------------------------------------------------------

test('count starts at zero and tracks start/stop', () => {
  assert.equal(openSessionsCount(), 0);
  openSessionStarted('s1');
  openSessionStarted('s2');
  assert.equal(openSessionsCount(), 2);
  openSessionStopped('s1');
  assert.equal(openSessionsCount(), 1);
  openSessionStopped('s2');
  assert.equal(openSessionsCount(), 0);
});

test('sessionIds are unique — double start counts once, one stop clears it', () => {
  openSessionStarted('s1');
  openSessionStarted('s1'); // e.g. the process monitor's writer-refresh re-register
  assert.equal(openSessionsCount(), 1);
  openSessionStopped('s1');
  assert.equal(openSessionsCount(), 0);
});

test('stop of an unknown id and invalid ids are no-ops', () => {
  openSessionStopped('never-started');
  assert.equal(openSessionsCount(), 0);
  openSessionStarted('');
  openSessionStarted(null);
  openSessionStarted(undefined);
  assert.equal(openSessionsCount(), 0);
});

// --- broadcast --------------------------------------------------------------

test('broadcasts the new count to every open client when it changes', () => {
  const a = attachClient(makeFakeClient());
  const b = attachClient(makeFakeClient());

  openSessionStarted('s1');

  for (const client of [a, b]) {
    assert.equal(client.sent.length, 1);
    const msg = client.sent[0];
    assert.equal(msg.type, OPEN_SESSIONS_MESSAGE_TYPE);
    assert.equal(msg.type, 'open_sessions_count'); // pin the literal wire value
    assert.equal(msg.count, 1);
    assert.equal(typeof msg.timestamp, 'string');
  }

  openSessionStopped('s1');
  assert.equal(a.sent.length, 2);
  assert.equal(a.sent[1].count, 0);
});

test('does NOT broadcast when the count is unchanged (noise guard)', () => {
  const client = attachClient(makeFakeClient());

  openSessionStarted('s1');
  assert.equal(client.sent.length, 1);

  openSessionStarted('s1'); // dedupe — same count
  openSessionStopped('unknown'); // no-op — same count
  assert.equal(client.sent.length, 1);

  openSessionStarted('s2'); // real change
  assert.equal(client.sent.length, 2);
  assert.equal(client.sent[1].count, 2);
});

test('skips non-open sockets and survives a throwing send', () => {
  const closed = attachClient(makeFakeClient(3 /* CLOSED */));
  const broken = attachClient(makeFakeClient());
  broken.send = () => {
    throw new Error('socket died');
  };
  const healthy = attachClient(makeFakeClient());

  openSessionStarted('s1'); // must not throw despite the broken socket

  assert.equal(closed.sent.length, 0);
  assert.equal(healthy.sent.length, 1);
  assert.equal(healthy.sent[0].count, 1);
});

// --- initial value ----------------------------------------------------------

test('sendOpenSessionsCount delivers the current count to one socket only', () => {
  openSessionStarted('s1');
  openSessionStarted('s2');

  const newcomer = makeFakeClient();
  const bystander = attachClient(makeFakeClient());
  const bystanderBefore = bystander.sent.length;

  sendOpenSessionsCount(newcomer);

  assert.equal(newcomer.sent.length, 1);
  assert.equal(newcomer.sent[0].type, 'open_sessions_count');
  assert.equal(newcomer.sent[0].count, 2);
  // Initial send is unicast — nobody else hears it.
  assert.equal(bystander.sent.length, bystanderBefore);
});

test('sendOpenSessionsCount is a no-op for non-open sockets', () => {
  const closed = makeFakeClient(3 /* CLOSED */);
  sendOpenSessionsCount(closed);
  assert.equal(closed.sent.length, 0);
});
