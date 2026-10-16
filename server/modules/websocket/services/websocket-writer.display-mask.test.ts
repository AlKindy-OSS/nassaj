/**
 * ADR-210 (T-2036): the WebSocketWriter chokepoint masks secrets for every
 * viewer, keeps the requester's permission input raw, and leaves every other
 * kind byte-identical. Outcome recording still sees the raw payload.
 */
import assert from 'node:assert/strict';
import { mock, test } from 'node:test';

const outcomes: unknown[] = [];
mock.module('./session-outcome.service.js', {
  namedExports: {
    isOutcomeSignalKind: (kind: unknown) => kind === 'complete',
    applyOutcomePayload: (_sessionId: string, payload: unknown) => outcomes.push(payload),
  },
});
const { WebSocketWriter, addSessionMirror, removeSessionMirrorsForSocket } =
  await import('./websocket-writer.service.js');
// eslint-disable-next-line boundaries/no-unknown -- ADR-210 test seam of the display masking leaf service.
const { configureDisplayMaskForTests } = await import('@/services/display-secret-mask.js');

const SK = 'sk-' + 'ant-api03-AbCdEfGhIjKlMnOpQrStUvWx';

type FakeSocket = { readyState: number; userId?: number | null; frames: string[]; send(frame: string): void };
const socket = (userId: number | null = null): FakeSocket => ({ readyState: 1, userId, frames: [], send(frame) { this.frames.push(frame); } });

function quiet(env?: string): void {
  configureDisplayMaskForTests({
    env: () => env, readSetting: () => null, serviceLiterals: () => [], allUserIds: () => [], vendorLiterals: () => [],
  });
}

function withSession(sessionId: string, run: (writer: InstanceType<typeof WebSocketWriter>, primary: FakeSocket, mirror: FakeSocket) => void): void {
  // The run owner is user 1 (its primary socket); the mirror is member 2.
  const primary = socket(1);
  const mirror = socket(2);
  const writer = new WebSocketWriter(primary, 1);
  writer.setSessionId(sessionId);
  addSessionMirror(sessionId, mirror);
  try {
    run(writer, primary, mirror);
  } finally {
    removeSessionMirrorsForSocket(mirror);
  }
}

test.beforeEach(() => quiet());
test.after(() => configureDisplayMaskForTests(null));

test('requester socket gets raw permission_request.input, a mirror gets it masked', () => {
  withSession('perm', (writer, primary, mirror) => {
    const request = { kind: 'permission_request', sessionId: 'perm', requestId: 'r1', toolName: 'Bash', input: { command: `export KEY=${SK}` } };
    writer.send(request);
    assert.deepEqual(JSON.parse(primary.frames[0]), request);
    assert.ok(!mirror.frames[0].includes(SK));
    assert.match(mirror.frames[0], /\[masked:/);
  });
});

test('text, tool_use and tool_result are masked for the primary and the mirrors alike', () => {
  withSession('txt', (writer, primary, mirror) => {
    writer.send({ kind: 'text', sessionId: 'txt', role: 'assistant', content: `key ${SK}` });
    writer.send({ kind: 'tool_use', sessionId: 'txt', toolInput: { command: `curl -H "Authorization: Bearer ${SK}"` } });
    writer.send({ kind: 'tool_result', sessionId: 'txt', toolResult: { content: SK } });
    for (const frame of [...primary.frames, ...mirror.frames]) assert.ok(!frame.includes(SK), frame);
    assert.equal(primary.frames.length, 3);
    assert.deepEqual(primary.frames, mirror.frames);
  });
});

test('non-text kinds are delivered byte-for-byte, even when they carry secret-shaped text', () => {
  withSession('raw', (writer, primary, mirror) => {
    const payloads = [
      { kind: 'status', sessionId: 'raw', text: SK },
      { kind: 'session_created', sessionId: 'raw', newSessionId: 'n' },
      { type: 'session-status', sessionId: 'raw', isProcessing: true },
      { kind: 'permission_cancelled', sessionId: 'raw', requestId: SK },
    ];
    for (const payload of payloads) writer.send(payload);
    assert.deepEqual(primary.frames, payloads.map((payload) => JSON.stringify(payload)));
    assert.deepEqual(mirror.frames, primary.frames);
  });
});

test('a secret split across deltas never reaches any viewer; the tail is flushed before stream_end', () => {
  withSession('split', (writer, primary, mirror) => {
    const parts = ['Your key is sk-', 'ant-api03-AbCd', 'EfGhIjKlMnOp', 'QrStUvWx and more'];
    for (const content of parts) writer.send({ kind: 'stream_delta', sessionId: 'split', content });
    writer.send({ kind: 'stream_end', sessionId: 'split' });
    for (const frames of [primary.frames, mirror.frames]) {
      const decoded = frames.map((frame) => JSON.parse(frame) as { kind: string; content?: string });
      const text = decoded.map((frame) => frame.content ?? '').join('');
      assert.equal(text, 'Your key is [masked:anthropic-openai-key] and more');
      for (const frame of frames) {
        for (const part of ['ant-api03', 'EfGhIjKl', 'QrStUvWx']) assert.ok(!frame.includes(part), frame);
      }
      assert.equal(decoded.at(-1)?.kind, 'stream_end');
      assert.equal(decoded.at(-2)?.kind, 'stream_delta', 'the held tail precedes stream_end');
    }
  });
});

test('outcome recording keeps the raw payload', () => {
  outcomes.length = 0;
  withSession('outcome', (writer) => {
    const complete = { kind: 'complete', sessionId: 'outcome', success: true };
    writer.send(complete);
    assert.deepEqual(outcomes, [complete]);
  });
});

test('kill switch NASSAJ_DISPLAY_MASKING=0 restores raw delivery', () => {
  quiet('0');
  withSession('off', (writer, primary, mirror) => {
    const payload = { kind: 'text', sessionId: 'off', content: `key ${SK}` };
    writer.send(payload);
    assert.deepEqual(primary.frames, [JSON.stringify(payload)]);
    assert.deepEqual(mirror.frames, [JSON.stringify(payload)]);
  });
});

test('I1: raw permission input follows the run owner, not the primary position', () => {
  const ownerTab1 = socket(1);
  const ownerTab2 = socket(1);
  const member = socket(2);
  const writer = new WebSocketWriter(ownerTab1, 1);
  writer.setSessionId('i1');
  addSessionMirror('i1', ownerTab2);
  addSessionMirror('i1', member);
  try {
    const request = { kind: 'permission_request', sessionId: 'i1', requestId: 'r', toolName: 'AskUserQuestion', input: { q: `key ${SK}?` } };
    writer.send(request);
    assert.deepEqual(JSON.parse(ownerTab2.frames[0]), request, "the owner's second tab gets raw input");
    assert.ok(!member.frames[0].includes(SK), 'another member mirror gets it masked');
    // The owner's socket dies; a reclaim moves the primary to another member's socket.
    const reclaimed = socket(2);
    writer.updateWebSocket(reclaimed as never);
    writer.send({ ...request, requestId: 'r2' });
    assert.ok(!reclaimed.frames[0].includes(SK), 'a non-owner primary gets masked input');
    assert.deepEqual(JSON.parse(ownerTab2.frames[1]), { ...request, requestId: 'r2' }, 'the owner tab still gets raw');
  } finally {
    for (const s of [ownerTab2, member]) removeSessionMirrorsForSocket(s as never);
  }
});
