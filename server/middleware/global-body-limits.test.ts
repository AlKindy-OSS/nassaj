import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';

import { createGlobalBodyParsers, isPayloadTooLargeError } from './global-body-limits.js';

function request(body: string, contentType: string) {
  const req = Readable.from([body]) as Readable & {
    headers: Record<string, string>;
    method: string;
    url: string;
    body?: unknown;
  };
  req.headers = {
    'content-type': contentType,
    'content-length': String(Buffer.byteLength(body)),
  };
  req.method = 'POST';
  req.url = '/unauthenticated';
  return req;
}

async function invoke(parser: Function, req: Readable) {
  return new Promise<unknown>((resolve) => {
    parser(req, {}, (error?: unknown) => resolve(error ?? null));
  });
}

test('oversized unauthenticated JSON is rejected with 413 before the handler', async () => {
  const [jsonParser] = createGlobalBodyParsers();
  const error = await invoke(
    jsonParser,
    request(JSON.stringify({ value: 'x'.repeat(1024 * 1024) }), 'application/json'),
  ) as { status?: number };
  assert.equal(error?.status, 413);
  assert.equal(isPayloadTooLargeError(error), true);
});

test('only body-parser oversize errors map to the public 413 contract', () => {
  assert.equal(isPayloadTooLargeError({ status: 413 }), true);
  assert.equal(isPayloadTooLargeError({ type: 'entity.too.large' }), true);
  assert.equal(isPayloadTooLargeError(new Error('synthetic')), false);
});

test('multipart remains unparsed by the global JSON and urlencoded parsers', async () => {
  const req = request('--synthetic--\r\n', 'multipart/form-data; boundary=synthetic');
  for (const parser of createGlobalBodyParsers()) {
    assert.equal(await invoke(parser, req), null);
  }
  assert.deepEqual(req.body, {}, 'multipart bytes are not parsed into application fields');
  assert.equal(req.readableEnded, false, 'multipart stream remains available to its route parser');
});
