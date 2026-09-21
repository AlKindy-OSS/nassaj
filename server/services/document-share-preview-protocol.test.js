import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { FRAME_BYTES, createMessageReader, createMessageWriter, decodeBytes, exactFields } from './document-share-preview-protocol.js';

function frame(bytes, total = bytes.length, flags = 3) {
  const header = Buffer.alloc(9);
  header.writeUInt32BE(bytes.length, 0);
  header.writeUInt32BE(total, 4);
  header[8] = flags;
  return Buffer.concat([header, bytes]);
}

test('framed messages survive split headers, chunk boundaries, and backpressure', async () => {
  const stream = new PassThrough({ highWaterMark: 32 });
  const messages = [];
  const errors = [];
  const detach = createMessageReader(stream, 300_000, (message) => { messages.push(message); }, (error) => errors.push(error));
  const send = createMessageWriter(stream, 300_000);
  await send({ text: 'x'.repeat(160_000) });
  const next = frame(Buffer.from('{"ok":true}'));
  for (const byte of next) stream.write(Buffer.from([byte]));
  stream.end();
  assert.deepEqual(messages, [{ text: 'x'.repeat(160_000) }, { ok: true }]);
  assert.deepEqual(errors, []);
  detach();
});

test('writer rejects overlapping messages and accounts all wire bytes', async () => {
  let release;
  const sink = new Writable({ highWaterMark: 1, write(_chunk, _encoding, done) { release = done; } });
  const send = createMessageWriter(sink, 100);
  const first = send({ a: 1 });
  await assert.rejects(send({ a: 2 }), { status: 503 });
  release();
  await first;
  await assert.rejects(createMessageWriter(new PassThrough(), 12)({ a: 1 }), { status: 413 });
  const stream = new PassThrough(); stream.resume();
  const small = createMessageWriter(stream, 25);
  await small({ a: 1 });
  await assert.rejects(small({ a: 2 }), { status: 413 });
});

test('decoder rejects malformed, oversized, truncated, overlapping and over-budget frames', async () => {
  const cases = [
    [frame(Buffer.from('x')), 503],
    [frame(Buffer.alloc(FRAME_BYTES)), 413],
    [frame(Buffer.from('{}'), 101), 413],
    [frame(Buffer.from('{}'), 2, 0), 503],
    [frame(Buffer.from('{}'), 2, 4), 503],
    [frame(Buffer.from('{}'), 2, 1), 503],
    [frame(Buffer.alloc(0)), 503],
    [Buffer.concat([frame(Buffer.from('{'), 2, 1), frame(Buffer.from('}'), 2, 3)]), 503],
    [Buffer.concat([frame(Buffer.from('{'), 2, 1), frame(Buffer.from('}'), 3, 2)]), 503],
    [Buffer.concat([frame(Buffer.from('{'), 2, 1), frame(Buffer.from('}}'), 2, 2)]), 503],
    [frame(Buffer.from('{'), 2, 1), 503],
    [Buffer.from([0]), 503],
    [Buffer.alloc(101), 413],
  ];
  for (const [bytes, status] of cases) {
    const stream = new PassThrough();
    const failed = Promise.withResolvers();
    const detach = createMessageReader(stream, 100, () => assert.fail('must reject'), failed.resolve);
    stream.end(bytes);
    assert.equal((await failed.promise).status, status);
    detach();
  }
});

test('decoder rejects new requests until async read/response completes', async () => {
  const stream = new PassThrough();
  const failed = Promise.withResolvers();
  const resume = Promise.withResolvers();
  let calls = 0;
  const detach = createMessageReader(stream, 100, () => { calls++; return resume.promise; }, failed.resolve);
  stream.write(Buffer.concat([frame(Buffer.from('{}')), frame(Buffer.from('{}'))]));
  assert.equal((await failed.promise).status, 503);
  assert.equal(calls, 1);
  resume.resolve();
  detach();
  stream.destroy();
});

test('canonical base64 and exact object schemas are required', () => {
  assert.equal(decodeBytes('aGk=', 2).toString(), 'hi');
  assert.equal(decodeBytes('', 1).length, 0);
  for (const value of ['aGk', '$$$$', 'Zh==']) assert.throws(() => decodeBytes(value, 3), { status: 503 });
  assert.throws(() => decodeBytes('YWJj', 2), { status: 413 });
  assert.throws(() => decodeBytes('YWJjZA==', 2), { status: 413 });
  assert.throws(() => decodeBytes(null, 2), { status: 503 });
  assert.equal(exactFields({ ok: 1 }, ['ok']), true);
  for (const value of [null, [], { ok: 1, extra: 1 }, {}]) assert.equal(exactFields(value, ['ok']), false);
});
