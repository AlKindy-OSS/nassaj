/** T-2094: ndjson JSON-RPC connection used by every ACP adapter. */
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { test } from 'node:test';

import { createAcpConnection, AcpRpcError } from './acp-connection.js';

/** A connection wired to in-memory pipes; `agentOut` lines are what the agent wrote back. */
function harness(options: Record<string, unknown> = {}) {
  const toAgent = new PassThrough();
  const fromAgent = new PassThrough();
  const written: any[] = [];
  toAgent.on('data', (b) => String(b).split('\n').filter(Boolean).forEach((l) => written.push(JSON.parse(l))));
  const fatal: Error[] = [];
  const notes: any[] = [];
  const conn = createAcpConnection({
    input: fromAgent,
    output: toAgent,
    onNotification: (method: string, params: unknown) => notes.push({ method, params }),
    onFatal: (err: Error) => fatal.push(err),
    ...options,
  });
  const agentSays = (msg: unknown) => fromAgent.write(`${JSON.stringify(msg)}\n`);
  const tick = () => new Promise((r) => setImmediate(r));
  return { conn, written, fatal, notes, agentSays, fromAgent, tick };
}

test('request/response correlates ids; JSON-RPC errors reject with AcpRpcError', async () => {
  const h = harness();
  const ok = h.conn.request('initialize', { protocolVersion: 1 });
  const bad = h.conn.request('session/new', {});
  await h.tick();
  assert.deepEqual(h.written.map((m) => m.method), ['initialize', 'session/new']);
  h.agentSays({ jsonrpc: '2.0', id: h.written[1].id, error: { code: -32000, message: 'Authentication required' } });
  h.agentSays({ jsonrpc: '2.0', id: h.written[0].id, result: { protocolVersion: 1 } });
  assert.deepEqual(await ok, { protocolVersion: 1 });
  await assert.rejects(bad, (err: any) => err instanceof AcpRpcError && err.code === -32000);
});

test('a line split across chunks (multibyte) is reassembled', async () => {
  const h = harness();
  const line = Buffer.from(`${JSON.stringify({ jsonrpc: '2.0', method: 'session/update', params: { t: 'مرحبا' } })}\n`);
  h.fromAgent.write(line.subarray(0, 50));
  h.fromAgent.write(line.subarray(50));
  await h.tick();
  assert.deepEqual(h.notes, [{ method: 'session/update', params: { t: 'مرحبا' } }]);
});

test('inbound requests are answered with the handler result, or -32601 / -32603', async () => {
  const h = harness({
    onRequest: async (method: string) => {
      if (method === 'boom') throw new Error('handler failed');
      return method === 'session/request_permission' ? { outcome: { outcome: 'cancelled' } } : undefined;
    },
  });
  h.agentSays({ jsonrpc: '2.0', id: 5, method: 'session/request_permission', params: {} });
  h.agentSays({ jsonrpc: '2.0', id: 6, method: 'fs/read_text_file', params: {} });
  h.agentSays({ jsonrpc: '2.0', id: 7, method: 'boom', params: {} });
  await h.tick(); await h.tick();
  const byId = Object.fromEntries(h.written.map((m) => [m.id, m]));
  assert.deepEqual(byId[5].result, { outcome: { outcome: 'cancelled' } });
  assert.equal(byId[6].error.code, -32601);
  assert.equal(byId[7].error.code, -32603);
  assert.doesNotMatch(JSON.stringify(byId[7]), /handler failed/, 'internal errors are not echoed');
});

test('a request times out and is rejected; a 0 timeout never expires', async () => {
  const h = harness();
  await assert.rejects(h.conn.request('slow', {}, { timeoutMs: 10 }), /timed out/);
  const forever = h.conn.request('session/prompt', {}, { timeoutMs: 0 });
  await new Promise((r) => setTimeout(r, 30));
  h.agentSays({ jsonrpc: '2.0', id: h.written.at(-1).id, result: { stopReason: 'end_turn' } });
  assert.deepEqual(await forever, { stopReason: 'end_turn' });
});

test('QA: a line over the cap is discarded to the next newline, fatal is raised once, never thrown', async () => {
  const h = harness({ maxLineBytes: 64 });
  const pending = h.conn.request('session/prompt', {}, { timeoutMs: 0 });
  pending.catch(() => {});
  h.fromAgent.write('x'.repeat(40));
  h.fromAgent.write('y'.repeat(40));
  h.fromAgent.write('z'.repeat(40));
  h.fromAgent.write(`tail\n${JSON.stringify({ jsonrpc: '2.0', method: 'after', params: {} })}\n`);
  await h.tick();
  assert.equal(h.fatal.length, 1);
  assert.equal((h.fatal[0] as any).code, 'acp_line_overflow');
  await assert.rejects(pending, /line exceeded/);
  assert.deepEqual(h.notes, [], 'a closed connection stops dispatching');
});

test('close() rejects every pending request and stops writes', async () => {
  const h = harness();
  const p = h.conn.request('x', {}, { timeoutMs: 0 });
  h.conn.close(new Error('process exited'));
  await assert.rejects(p, /process exited/);
  await assert.rejects(h.conn.request('y', {}), /closed/);
  assert.equal(h.conn.closed, true);
});

test('malformed lines are skipped without killing the connection', async () => {
  const h = harness();
  h.fromAgent.write('not json\n');
  h.agentSays({ jsonrpc: '2.0', method: 'ok', params: 1 });
  await h.tick();
  assert.deepEqual(h.notes, [{ method: 'ok', params: 1 }]);
  assert.equal(h.fatal.length, 0);
});
