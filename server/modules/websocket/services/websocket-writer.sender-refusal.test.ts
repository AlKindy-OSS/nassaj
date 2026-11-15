/**
 * ADR-173 P8 B2: a per-send refusal (`session_busy`, or any frame stamped
 * `notStarted: true`) answers the sender alone. It never fans out to the
 * session's other viewers, who would otherwise read "your message was not sent"
 * for a message they never wrote. Every other frame keeps the mirror fan-out.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

mock.module('./session-outcome.service.js', {
  namedExports: { isOutcomeSignalKind: () => false, applyOutcomePayload: () => undefined },
});
const { WebSocketWriter, addSessionMirror, countLiveMirrors, removeSessionMirrorsForSocket } =
  await import('./websocket-writer.service.js');

type FakeSocket = { readyState: number; userId?: number | null; frames: string[]; send(frame: string): void };
const socket = (userId: number | null = null): FakeSocket => ({ readyState: 1, userId, frames: [], send(frame) { this.frames.push(frame); } });

function withViewers(sessionId: string, run: (writer: InstanceType<typeof WebSocketWriter>, sender: FakeSocket,
  others: FakeSocket[]) => void): void {
  // The sender is member 2; the conversation's creator (1) and a second tab of the sender are mirrors.
  const sender = socket(2);
  const creator = socket(1);
  const senderOtherTab = socket(2);
  const writer = new WebSocketWriter(sender, 2);
  addSessionMirror(sessionId, sender);
  addSessionMirror(sessionId, creator);
  addSessionMirror(sessionId, senderOtherTab);
  try {
    run(writer, sender, [creator, senderOtherTab]);
  } finally {
    for (const s of [sender, creator, senderOtherTab]) removeSessionMirrorsForSocket(s as never);
  }
}

test('B2: session_busy reaches the sending socket only, never another viewer', () => {
  withViewers('busy', (writer, sender, others) => {
    writer.send({ kind: 'error', code: 'session_busy', sessionId: 'busy', provider: 'claude', clientMsgId: 'c1',
      content: 'This conversation already has a run in progress.' });
    assert.equal(sender.frames.length, 1);
    assert.equal(JSON.parse(sender.frames[0]).clientMsgId, 'c1');
    for (const other of others) assert.deepEqual(other.frames, [], 'no viewer reads a refusal of a message they did not send');
  });
});

test('B2: every notStarted refusal (error or complete) is the sender\'s alone', () => {
  withViewers('refused', (writer, sender, others) => {
    writer.send({ kind: 'complete', exitCode: 1, success: false, notStarted: true, code: 'shared_write_transcript_unavailable',
      sessionId: 'refused', provider: 'claude' });
    writer.send({ kind: 'error', notStarted: true, code: 'steer_requires_session_steer', sessionId: 'refused' });
    writer.send({ kind: 'complete', aborted: true, success: false, abortFailed: true, code: 'turn_stop_forbidden',
      notStarted: true, sessionId: 'refused' });
    assert.equal(sender.frames.length, 3);
    for (const other of others) assert.deepEqual(other.frames, []);
  });
});

test('B2: run frames, terminal errors and an aborted complete still fan out to every viewer', () => {
  withViewers('run', (writer, sender, others) => {
    writer.send({ kind: 'text', role: 'assistant', content: 'hi', sessionId: 'run' });
    writer.send({ kind: 'error', code: 'spawn_failed', sessionId: 'run' });
    writer.send({ kind: 'complete', aborted: true, success: true, sessionId: 'run' });
    assert.equal(sender.frames.length, 3);
    for (const other of others) assert.equal(other.frames.length, 3);
  });
});

test('B3: countLiveMirrors can leave out the sender\'s own socket', () => {
  const sender = socket(1);
  addSessionMirror('alone', sender);
  try {
    assert.equal(countLiveMirrors('alone'), 1);
    assert.equal(countLiveMirrors('alone', sender as never), 0, 'only the sender watches: no other viewer');
    const member = socket(2);
    addSessionMirror('alone', member);
    assert.equal(countLiveMirrors('alone', sender as never), 1);
    removeSessionMirrorsForSocket(member as never);
  } finally {
    removeSessionMirrorsForSocket(sender as never);
  }
});
