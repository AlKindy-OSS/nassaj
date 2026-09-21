import assert from 'node:assert/strict';
import test from 'node:test';

import { handleChatConnection } from './chat-websocket.service.js';

function fixture(overrides: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const listeners: Record<string, (arg: unknown) => Promise<void>> = {};
  const ws = {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: (event: string, callback: (arg: unknown) => Promise<void>) => { listeners[event] = callback; },
  };
  const deps = {
    getActiveClaudeSDKSessions: () => [],
    getSessionProvider: () => { throw new Error('secret-provider-token'); },
    ...overrides,
  } as unknown as Parameters<typeof handleChatConnection>[2];
  handleChatConnection(ws as never, { user: { id: 999998 } } as never, deps);
  return {
    send: (data: unknown) => listeners.message(typeof data === 'string' ? data : JSON.stringify(data)),
    errors: () => sent.filter(frame => frame.type === 'error'),
  };
}
const command = (id: string, sessionId = 'session-one') => ({
  type: 'codex-command', command: 'fixture', options: { clientMsgId: id, sessionId },
});

test('B1007 dispatch exception retains exact identity without claiming non-start or leaking details', async () => {
  const f = fixture();
  await f.send(command('cmid_one'));
  const [event] = f.errors();
  assert.equal(event.clientMsgId, 'cmid_one');
  assert.equal(event.sessionId, 'session-one');
  assert.equal(event.deliveryDisposition, 'unknown');
  assert.equal(event.sameClientMsgIdRetryable, false);
  assert.equal(event.notStarted, undefined);
  assert.equal(JSON.stringify(event).includes('secret-provider-token'), false);
});

test('B1007 concurrent callbacks retain their own identity when lease failures finish in reverse order', async () => {
  const rejectors: ((reason: Error) => void)[] = [];
  const f = fixture({ acquireWriterLease: () => new Promise((_resolve, reject) => rejectors.push(reject)) });
  const one = f.send(command('cmid_one', 'session-one'));
  const two = f.send(command('cmid_two', 'session-two'));
  rejectors[1](new Error('secret-lease-two'));
  await two;
  rejectors[0](new Error('secret-lease-one'));
  await one;
  assert.deepEqual(f.errors().map(e => [e.clientMsgId, e.sessionId]), [
    ['cmid_two', 'session-two'], ['cmid_one', 'session-one'],
  ]);
  for (const e of f.errors()) {
    assert.equal(e.deliveryDisposition, 'not_started');
    assert.equal(e.notStarted, true);
    assert.equal(e.sameClientMsgIdRetryable, true);
    assert.equal(JSON.stringify(e).includes('secret-lease'), false);
  }
});

test('B1007 control requests and malformed payloads cannot borrow the previous command identity', async () => {
  const f = fixture({ getActiveCodexSessions: () => { throw new Error('secret-control'); } });
  await f.send(command('cmid_previous'));
  await f.send({ type: 'get-active-sessions', options: { clientMsgId: 'cmid_spoof' } });
  await f.send('{invalid json');
  await f.send({});
  for (const event of f.errors().slice(1)) {
    assert.equal(event.clientMsgId, undefined);
    assert.equal(event.sessionId, undefined);
    assert.equal(event.deliveryDisposition, undefined);
    assert.equal(JSON.stringify(event).includes('secret-'), false);
  }
  assert.equal(f.errors().length, 4);
});

test('B1007 invalid command identity is not echoed even when dispatch throws', async () => {
  for (const id of ['private\nvalue', 'x'.repeat(129), '']) {
    const f = fixture();
    await f.send(command(id));
    assert.equal(f.errors()[0].clientMsgId, undefined);
    assert.equal(f.errors()[0].deliveryDisposition, undefined);
  }
  const f = fixture();
  await f.send({ ...command('cmid_valid'), command: { invalid: true } });
  assert.equal(f.errors()[0].clientMsgId, undefined);
});
