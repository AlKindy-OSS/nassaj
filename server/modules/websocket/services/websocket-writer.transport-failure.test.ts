import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const outcomes: Array<{ sessionId: string; payload: unknown }> = [];
mock.module('./session-outcome.service.js', {
  namedExports: {
    isOutcomeSignalKind: (kind: unknown) => kind === 'complete',
    applyOutcomePayload: (sessionId: string, payload: unknown) => outcomes.push({ sessionId, payload }),
  },
});
const { WebSocketWriter, addSessionMirror, removeSessionMirrorsForSocket } =
  await import('./websocket-writer.service.js');

test('a primary transport failure does not drop mirror frames or the terminal outcome', () => {
  const primary = { readyState: 1, send: () => { throw new Error('transport closed during send'); } };
  const received: string[] = [];
  const mirror = { readyState: 1, send: (frame: string) => received.push(frame) };
  const writer = new WebSocketWriter(primary);
  writer.setSessionId('transport-failure');
  addSessionMirror('transport-failure', mirror);
  try {
    const delta = { kind: 'text_delta', sessionId: 'transport-failure', text: 'retained' };
    const complete = { kind: 'complete', sessionId: 'transport-failure', success: true };
    assert.doesNotThrow(() => writer.send(delta));
    assert.doesNotThrow(() => writer.send(complete));
    assert.deepEqual(received.map((frame) => JSON.parse(frame)), [delta, complete]);
    assert.deepEqual(outcomes, [{ sessionId: 'transport-failure', payload: complete }]);
    assert.equal(writer.ws, primary, 'delivery failure must never swap the active writer');
  } finally {
    removeSessionMirrorsForSocket(mirror);
  }
});

test('a failing mirror cannot prevent delivery to other viewers or duplicate the primary frame', () => {
  const received: string[] = [];
  const primary = { readyState: 1, send: (frame: string) => received.push(frame) };
  const broken = { readyState: 1, send: () => { throw new Error('mirror closed'); } };
  const otherFrames: string[] = [];
  const other = { readyState: 1, send: (frame: string) => otherFrames.push(frame) };
  const writer = new WebSocketWriter(primary);
  for (const socket of [primary, broken, other]) addSessionMirror('mirror-failure', socket);
  try {
    const payload = { kind: 'text_delta', sessionId: 'mirror-failure', text: 'visible' };
    writer.send(payload);
    assert.deepEqual(received, [JSON.stringify(payload)]);
    assert.deepEqual(otherFrames, received);
  } finally {
    for (const socket of [primary, broken, other]) removeSessionMirrorsForSocket(socket);
  }
});

test('T-1854 (I7, qa M6): primary suppression mutes only the primary for one scoped send', () => {
  outcomes.length = 0;
  const primary = { readyState: 1, sent: [] as string[], send(frame: string) { this.sent.push(frame); } };
  const mirror = { readyState: 1, sent: [] as string[], send(frame: string) { this.sent.push(frame); } };
  const writer = new WebSocketWriter(primary, 42);
  addSessionMirror('foreign-socket-run', mirror);
  try {
    writer.sendWithPrimarySuppressed(() => writer.send({ kind: 'complete', sessionId: 'foreign-socket-run' }));
    assert.equal(primary.sent.length, 0, 'the foreign primary socket receives nothing');
    assert.equal(mirror.sent.length, 1, 'authorized mirrors keep the stream');
    assert.equal(outcomes.length, 1, 'the terminal outcome is still recorded');
    assert.equal(writer.ws, primary, 'the socket is never swapped');
    assert.equal(writer.isPrimarySocketAlive(), true,
      'B-SEC-DUP-RUN: a muted socket still counts as a live listener, so no second run is admitted');

    writer.send({ kind: 'chunk', sessionId: 'another-run' });
    assert.equal(primary.sent.length, 1, 'suppression is scoped to the fenced send only');
  } finally {
    removeSessionMirrorsForSocket(mirror);
  }
});

test('T-1854: the connection writer holds no per-session membership detach', () => {
  const primary = { readyState: 1, sent: [] as string[], send(frame: string) { this.sent.push(frame); } };
  const writer = new WebSocketWriter(primary, 42);
  writer.setSessionId('re-added-member-session');
  writer.send({ kind: 'chunk', sessionId: 're-added-member-session' });
  assert.equal(primary.sent.length, 1);
  assert.equal(writer.isRunOutputRevoked('re-added-member-session'), false);
  assert.equal('detachedSessionIds' in writer, false);
});

test('supervised run tokens reject reconnects and stale release generations', () => {
  const first = { readyState: 1, send: () => undefined };
  const second = { readyState: 1, send: () => undefined };
  const writer = new WebSocketWriter(first);
  const oldToken = writer.bindRevocableRun('same-session', 'claude');
  const newToken = writer.bindRevocableRun('same-session', 'claude');
  writer.releaseRevocableRun('same-session', oldToken);
  const [current] = writer.getRevocableRuns(first);
  assert.equal(current.token, newToken, 'old settlement cannot release the replacement run');
  writer.updateWebSocket(second);
  assert.deepEqual(writer.getRevocableRuns(first), [], 'old transport cannot enumerate the rejoined run');
  assert.equal(writer.isRevocableRunCurrent(current, first), false);
});
