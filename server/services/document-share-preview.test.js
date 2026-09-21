import assert from 'node:assert/strict';
import { EventEmitter, once } from 'node:events';
import { promises as fs } from 'node:fs';
import http from 'node:http';
import { PassThrough, Writable } from 'node:stream';
import test from 'node:test';

import { createSharedDocumentPreviewBuilder, launchDocumentPreviewParser } from './document-share-preview.js';
import { CHILD_WIRE_BYTES, PARENT_WIRE_BYTES, createMessageReader, createMessageWriter } from './document-share-preview-protocol.js';

const source = '<p>safe</p>';
const result = { type: 'result', html: Buffer.from(source).toString('base64'), warnings: [] };
const render = (builder, signal) => builder('/unused', 'docs/page.html', { root_dev: 'secret', root_ino: 'secret' }, signal);
const builderWith = (overrides = {}) => createSharedDocumentPreviewBuilder({ readDocument: async () => Buffer.from(source), ...overrides });
const turn = () => new Promise((resolve) => setImmediate(resolve));

function fakeChild(onSource = () => {}) {
  const child = new EventEmitter();
  child.pid = 123456789;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.kills = [];
  child.kill = (signal) => {
    child.kills.push(signal);
    queueMicrotask(() => child.emit('exit', null, signal));
    return true;
  };
  const send = createMessageWriter(child.stdout, CHILD_WIRE_BYTES);
  createMessageReader(child.stdin, PARENT_WIRE_BYTES, (message) => onSource(message, send, child), () => {});
  return child;
}

test('fixed child argv/env excludes secrets, Node options and inherited execArgv', async () => {
  const child = launchDocumentPreviewParser();
  try {
    assert.deepEqual(child.spawnargs, [process.execPath, '--max-old-space-size=128',
      new URL('./document-share-preview-child.js', import.meta.url).pathname]);
    const environment = (await fs.readFile(`/proc/${child.pid}/environ`, 'utf8')).split('\0').filter(Boolean).sort();
    assert.deepEqual(environment, ['LANG=C.UTF-8', 'TZ=UTC']);
    assert.equal(child.stdio[2], null);
  } finally {
    const exited = once(child, 'exit');
    child.kill('SIGKILL');
    await exited;
  }
});

test('9000 nested divs preserve HTTP responsiveness and heartbeat, meet deadline, and leave no child', async (t) => {
  const server = http.createServer((_req, res) => res.end('alive'));
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const url = `http://127.0.0.1:${server.address().port}`;
  let child;
  const builder = builderWith({ readDocument: async () => Buffer.from('<div>'.repeat(9000) + '</div>'.repeat(9000)),
    launchChild: () => { child = launchDocumentPreviewParser(); return child; } });
  const gaps = []; const latencies = []; const requests = [];
  let previous = performance.now();
  const heartbeat = setInterval(() => { const now = performance.now(); gaps.push(now - previous); previous = now; }, 20);
  const probe = setInterval(() => {
    const start = performance.now();
    requests.push(fetch(url).then((response) => response.text()).then(() => latencies.push(performance.now() - start)));
  }, 20);
  const start = performance.now();
  try { await assert.rejects(render(builder), { status: 504 }); }
  finally { clearInterval(heartbeat); clearInterval(probe); }
  const elapsed = performance.now() - start;
  await Promise.all(requests);
  latencies.sort((a, b) => a - b);
  const p95 = latencies[Math.floor(latencies.length * 0.95)];
  assert.ok(latencies.length > 30);
  assert.ok(p95 <= 200, `p95=${p95}`);
  assert.ok(Math.max(...latencies) <= 500, `max=${Math.max(...latencies)}`);
  assert.ok(Math.max(...gaps) <= 500, `heartbeat=${Math.max(...gaps)}`);
  assert.ok(elapsed <= 3500, `deadline=${elapsed}`);
  await assert.rejects(fs.stat(`/proc/${child.pid}`), { code: 'ENOENT' });
  t.diagnostic(JSON.stringify({ elapsed, p95, max: Math.max(...latencies), heartbeatMax: Math.max(...gaps), probes: latencies.length }));
  assert.match((await render(builderWith())).html, /safe/);
});

test('two global slots reject third without a queue and recover after cancellation', async () => {
  const children = [];
  const builder = builderWith({ launchChild: () => { const child = fakeChild(); children.push(child); return child; } });
  const aborts = [new AbortController(), new AbortController()];
  const pending = aborts.map((abort) => assert.rejects(render(builder, abort.signal), { status: 499 }));
  await turn();
  assert.equal(children.length, 2);
  await assert.rejects(render(builderWith()), { status: 429 });
  aborts.forEach((abort) => abort.abort());
  await Promise.all(pending);
  assert.ok(children.every((child) => child.kills.every((signal) => signal === 'SIGKILL')));
  assert.match((await render(builderWith())).html, /safe/);
});

test('slot stays reserved until child exit AND outstanding parent asset I/O cleanup', async () => {
  const entered = Promise.withResolvers(); const release = Promise.withResolvers();
  const abort = new AbortController();
  let child;
  const builder = builderWith({ launchChild: () => {
    child = fakeChild((_message, send) => { void send({ type: 'asset', seq: 1, kind: 'image', reference: 'page.assets/a.png', baseReference: 'docs/page.html' }); });
    child.kill = () => true;
    return child;
  }, readAsset: async () => { entered.resolve(); await release.promise; return { bytes: Buffer.from('a') }; } });
  const pending = assert.rejects(render(builder, abort.signal), { status: 499 });
  await entered.promise;
  const otherAbort = new AbortController();
  const other = assert.rejects(render(builderWith({ launchChild: () => fakeChild() }), otherAbort.signal), { status: 499 });
  await turn(); abort.abort(); await turn();
  await assert.rejects(render(builderWith()), { status: 429 });
  child.emit('exit', null, 'SIGKILL'); await turn();
  await assert.rejects(render(builderWith()), { status: 429 });
  release.resolve(); await pending;
  otherAbort.abort(); await other;
  assert.match((await render(builderWith())).html, /safe/);
});

test('abort before read/spawn, sync spawn throw, spawn error without pid, and crash are safe', async () => {
  const abort = new AbortController(); abort.abort();
  await assert.rejects(render(builderWith({ readDocument: () => assert.fail('read after abort') }), abort.signal), { status: 499 });
  const duringRead = new AbortController();
  await assert.rejects(render(builderWith({ readDocument: async () => { duringRead.abort(); return Buffer.from(source); },
    launchChild: () => assert.fail('spawn after abort') }), duringRead.signal), { status: 499 });
  await assert.rejects(render(builderWith({ launchChild: () => { throw new Error('/private/path'); } })), { status: 503 });
  await assert.rejects(render(builderWith({ launchChild: () => {
    const child = fakeChild(); delete child.pid;
    queueMicrotask(() => child.emit('error', new Error('spawn ENOENT')));
    return child;
  } })), { status: 503 });
  await assert.rejects(render(builderWith({ launchChild: () => fakeChild((_message, _send, child) => {
    child.emit('exit', 1, null); child.stdout.end(); child.emit('close', 1, null);
  }) })), { status: 503 });
  assert.match((await render(builderWith())).html, /safe/);
});

test('timeout and cancellation settle writes blocked by backpressure without drain/error', async () => {
  for (const cancel of [false, true]) {
    const abort = new AbortController();
    const builder = builderWith({ launchChild: () => {
      const child = fakeChild();
      child.stdin = new Writable({ highWaterMark: 1, write() {} });
      child.kill = () => { child.stdin.destroy(); queueMicrotask(() => child.emit('exit', null, 'SIGKILL')); return true; };
      return child;
    } });
    const start = performance.now();
    const pending = assert.rejects(render(builder, abort.signal), { status: cancel ? 499 : 504 });
    if (cancel) { await turn(); abort.abort(); }
    await pending;
    assert.ok(performance.now() - start <= 3500);
  }
  assert.match((await render(builderWith())).html, /safe/);
});

test('exit before buffered stdout result does not discard a complete result', async () => {
  const builder = builderWith({ launchChild: () => fakeChild((_source, send, child) => {
    child.emit('exit', 0, null);
    setImmediate(() => { void send(result).then(() => child.stdout.end()); });
  }) });
  assert.equal((await render(builder)).html, source);
});

test('parent enforces source size, result schemas and output size without DOM imports', async () => {
  await assert.rejects(render(builderWith({ readDocument: async () => Buffer.alloc(512 * 1024 + 1) })), { status: 413 });
  await assert.rejects(builderWith()('/unused', 'docs/file.txt'), { status: 404 });
  for (const message of [null, {}, { ...result, root: '/secret' }, { ...result, warnings: ['BAD'] },
    { type: 'error', code: 'CRASH' }, { ...result, html: '$$$$' }]) {
    await assert.rejects(render(builderWith({ launchChild: () => fakeChild((_source, send) => { void send(message); }) })), { status: 503 });
  }
  await assert.rejects(render(builderWith({ launchChild: () => fakeChild((_source, send) => {
    void send({ ...result, html: Buffer.alloc(8 * 1024 * 1024 + 1).toString('base64') });
  }) })), { status: 413 });
  for (const filename of ['document-share-preview.js', 'document-share-preview-protocol.js', 'document-share-files.js']) {
    const text = await fs.readFile(new URL(filename, import.meta.url), 'utf8');
    assert.doesNotMatch(text, /(?:from|import\s*\()\s*['"](?:jsdom|dompurify|postcss|.*preview-renderer)/);
  }
});

test('parent rejects asset request schema, sequence, scope basis, kind and lengths before reading', async () => {
  const request = { type: 'asset', seq: 1, kind: 'image', reference: 'page.assets/a.png', baseReference: 'docs/page.html' };
  for (const message of [{ ...request, root: '/secret' }, { ...request, seq: 2 }, { ...request, seq: '1' },
    { ...request, kind: 'script' }, { ...request, reference: 'a'.repeat(513) },
    { ...request, reference: '' }, { ...request, reference: null }, { ...request, reference: 'x.js' },
    { ...request, baseReference: '/other' }, { ...request, baseReference: 'x'.repeat(1025) }]) {
    await assert.rejects(render(builderWith({ launchChild: () => fakeChild((_source, send) => { void send(message); }),
      readAsset: () => assert.fail('invalid request reached I/O') })), { status: 503 });
  }
});
