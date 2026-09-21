/** C1 real Node transport contracts; temporary loopback only, no SDK or application server. */
import assert from 'node:assert/strict';
import http, { type IncomingMessage, type ServerResponse } from 'node:http';
import net, { type AddressInfo, type Socket } from 'node:net';
import test from 'node:test';
import { HistoryBudgetError } from './history-budget.service.js';
import { HistoryHttpSink } from './history-response.service.js';

async function loopback(handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>, run: (port: number) => Promise<void>) {
  const sockets = new Set<Socket>(), tasks: Promise<void>[] = [];
  const server = http.createServer((req, res) => { const task = handler(req, res); tasks.push(task); void task.catch(() => {}); });
  server.on('connection', socket => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try { await run((server.address() as AddressInfo).port); await Promise.all(tasks); }
  finally { for (const socket of sockets) socket.destroy(); await new Promise<void>(resolve => server.close(() => resolve())); }
}

async function client(port: number) {
  return new Promise<{ response: IncomingMessage; body: Buffer }>((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, agent: false }, response => {
      const chunks: Buffer[] = []; let bytes = 0;
      response.on('data', (chunk: Buffer) => { bytes += chunk.length; if (bytes > 8 * 1024 * 1024) request.destroy(new Error('test response cap')); else chunks.push(chunk); });
      response.once('end', () => resolve({ response, body: Buffer.concat(chunks) })); response.once('error', reject);
    });
    request.once('error', reject); request.setTimeout(2000, () => request.destroy(new Error('test timeout')));
  });
}

for (const [code, status] of [
  ['HISTORY_BUDGET_EXCEEDED', 413], ['HISTORY_SOURCE_INVALID', 422], ['HISTORY_BUSY', 503],
  ['HISTORY_TIMEOUT', 504], ['HISTORY_SOURCE_INCOMPLETE', 409], ['HISTORY_REVISION_CHANGED', 409], ['HISTORY_SOURCE_UNAVAILABLE', 409],
] as const) test(`memory HTTP maps ${code} to structured ${status} before headers`, async () => {
  await loopback(async (_req, res) => {
    const sink = new HistoryHttpSink(res); await sink.sendFailure(new HistoryBudgetError(code));
    assert.equal(sink.retainedBytes, 0);
  }, async port => {
    const { response, body } = await client(port);
    assert.equal(response.statusCode, status); assert.equal(JSON.parse(body.toString()).error.code, code);
    assert.equal(body.includes(Buffer.from('memory-budget-session')), false);
    if (status === 503) assert.match(String(response.headers['retry-after']), /^\d+$/);
  });
});

test('memory HTTP transmits owned Unicode bytes once and awaits completion', async () => {
  const body = Buffer.from(JSON.stringify({ messages: [{ id: 'synthetic', content: 'العربية 🧵' }] }));
  await loopback(async (_req, res) => {
    const sink = new HistoryHttpSink(res);
    await sink.write(body, new AbortController().signal); await sink.complete();
    assert.equal(sink.retainedBytes, 0);
  }, async port => {
    const result = await client(port); assert.deepEqual(result.body, body);
    assert.equal(result.response.headers['content-length'], String(body.length));
  });
});

test('memory HTTP client disconnect rejects pending completion and releases transport bytes', async () => {
  await loopback(async (_req, res) => {
    const sink = new HistoryHttpSink(res);
    await sink.write(Buffer.alloc(8 * 1024 * 1024, 120), new AbortController().signal);
    await assert.rejects(sink.complete()); await sink.abort();
    assert.equal(sink.signal.aborted, true); assert.equal(sink.retainedBytes, 0);
  }, async port => {
    const socket = net.createConnection({ host: '127.0.0.1', port });
    await new Promise<void>((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
    socket.pause(); socket.write('GET / HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
    await new Promise(resolve => setTimeout(resolve, 30)); socket.destroy();
  });
});
