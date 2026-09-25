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

test('identity revocation suppresses late primary, mirror and outcome persistence', () => {
  outcomes.length = 0;
  const primaryFrames: string[] = [];
  const mirrorFrames: string[] = [];
  const primary = { readyState: 1, send: (frame: string) => primaryFrames.push(frame) };
  const mirror = { readyState: 1, send: (frame: string) => mirrorFrames.push(frame) };
  const replacement = { readyState: 1, send: () => {} };
  const writer = new WebSocketWriter(primary);
  writer.setSessionId('revoked-run');
  addSessionMirror('revoked-run', mirror);
  try {
    assert.equal(writer.revokeRunOutput(replacement), false, 'stale socket cannot revoke replacement');
    assert.equal(writer.revokeRunOutput(primary), true);
    writer.send({ kind: 'complete', sessionId: 'revoked-run', success: true });
    assert.deepEqual(primaryFrames, []);
    assert.deepEqual(mirrorFrames, []);
    assert.deepEqual(outcomes, [], 'terminal outcome is not persisted after revocation');
  } finally {
    removeSessionMirrorsForSocket(mirror);
  }
});

test('project revocation fences the affected session before a close handshake', () => {
  outcomes.length = 0;
  const primary = { readyState: 1, sent: [] as string[], send(frame: string) { this.sent.push(frame); } };
  const mirror = { readyState: 1, sent: [] as string[], send(frame: string) { this.sent.push(frame); } };
  const writer = new WebSocketWriter(primary, 42);
  writer.setSessionId('project-session');
  addSessionMirror('project-session', mirror);
  writer.bindRevocableRun('project-session', 'opencode');

  try {
    assert.equal(writer.revokeProjectSessions(['project-session'], primary), 1);
    writer.send({ kind: 'complete', sessionId: 'project-session' });
    assert.equal(primary.sent.length, 0);
    assert.equal(mirror.sent.length, 0);
    assert.equal(outcomes.length, 0, 'late terminal outcome is not persisted');

    writer.setSessionId('other-project-session');
    writer.send({ kind: 'chunk', sessionId: 'other-project-session' });
    assert.equal(primary.sent.length, 1, 'unrelated project output remains live');
  } finally {
    removeSessionMirrorsForSocket(mirror);
  }
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
