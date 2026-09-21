import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import test from 'node:test';

import { runDocumentPreviewParser } from './document-share-preview-child.js';
import { CHILD_WIRE_BYTES, PARENT_WIRE_BYTES, createMessageReader, createMessageWriter, PreviewProtocolError } from './document-share-preview-protocol.js';

const source = { type: 'source', relativePath: 'docs/page.html', bytes: Buffer.from('<p>ok</p>').toString('base64') };

function session(t, renderer) {
  const input = new PassThrough(); const output = new PassThrough();
  const messages = []; const next = Promise.withResolvers(); const terminated = Promise.withResolvers();
  const detach = runDocumentPreviewParser(input, output, terminated.resolve, renderer);
  const off = createMessageReader(output, CHILD_WIRE_BYTES, (message) => {
    messages.push(message); next.resolve(message);
  }, (error) => next.reject(error));
  t.after(() => { detach(); off(); input.destroy(); output.destroy(); });
  return { input, output, messages, next: next.promise, terminated: terminated.promise,
    send: createMessageWriter(input, PARENT_WIRE_BYTES) };
}

test('child session renders actual HTML without inheriting server I/O', async (t) => {
  const f = session(t);
  await f.send(source);
  const result = await f.next;
  assert.equal(result.type, 'result');
  assert.match(Buffer.from(result.html, 'base64').toString(), /<p>ok<\/p>/);
});

test('child asset requests expose only reference/kind/base/seq and consume bounded bytes', async (t) => {
  const received = Promise.withResolvers();
  const f = session(t, async (_bytes, relativePath, readAsset) => {
    const file = await readAsset('page.assets/a.png', 'image', relativePath);
    received.resolve(file.bytes.toString());
    return { html: '<p>asset</p>', warnings: [] };
  });
  await f.send(source);
  assert.deepEqual(await f.next, { type: 'asset', seq: 1, kind: 'image', reference: 'page.assets/a.png', baseReference: 'docs/page.html' });
  await f.send({ type: 'asset', seq: 1, bytes: Buffer.from('safe').toString('base64') });
  assert.equal(await received.promise, 'safe');
});

test('child omission responses are renderer errors and never path-bearing output', async (t) => {
  const omitted = Promise.withResolvers();
  const f = session(t, async (_bytes, relativePath, readAsset) => {
    await assert.rejects(readAsset('page.assets/a.png', 'image', relativePath), { code: 'SHARE_UNAVAILABLE' });
    omitted.resolve();
    return { html: '<p>omitted</p>', warnings: ['RESOURCE_OMITTED'] };
  });
  await f.send(source); await f.next;
  await f.send({ type: 'asset', seq: 1, bytes: null });
  await omitted.promise;
});

test('child rejects bad source schemas, unexpected responses, and mismatched sequence', async (t) => {
  for (const message of [{}, { ...source, root: '/private' }, { ...source, relativePath: 1 },
    { ...source, relativePath: 'a'.repeat(1025) }]) {
    const f = session(t);
    await f.send(message);
    assert.equal(await f.terminated, 1);
  }
  for (const message of [{ type: 'asset', seq: 2, bytes: '' }, { type: 'asset', seq: 1, bytes: '', root: '/private' }]) {
    const f = session(t, async (_bytes, relativePath, readAsset) => readAsset('page.assets/a.png', 'image', relativePath));
    await f.send(source); await f.next; await f.send(message);
    assert.equal(await f.terminated, 1);
  }
});

test('child reports size limits as 413-compatible code and crashes as generic failure', async (t) => {
  for (const error of [new PreviewProtocolError('DOCUMENT_TOO_LARGE', 413), new Error('/private/path')]) {
    const f = session(t, async () => { throw error; });
    await f.send(source);
    assert.deepEqual(await f.next, { type: 'error', code: error.code ?? 'TEMPORARILY_UNAVAILABLE' });
  }
  const invalid = session(t);
  await invalid.send({ ...source, bytes: '%%%%' });
  assert.deepEqual(await invalid.next, { type: 'error', code: 'TEMPORARILY_UNAVAILABLE' });
});

test('child input EOF and output error terminate without logging data', async () => {
  for (const fail of [false, true]) {
    const input = new PassThrough(); const output = new PassThrough();
    const ended = Promise.withResolvers();
    const detach = runDocumentPreviewParser(input, output, ended.resolve);
    if (fail) output.emit('error', new Error('/private/path')); else input.end();
    assert.equal(await ended.promise, fail ? 1 : 0);
    detach(); input.destroy(); output.destroy();
  }
});
