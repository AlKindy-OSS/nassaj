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
