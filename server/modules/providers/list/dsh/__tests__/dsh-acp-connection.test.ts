/**
 * dsh-acp-connection.test — ndjson JSON-RPC framing and correlation of the
 * minimal ACP client (T-2086 S2, ADR-224).
 */

import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { describe, it } from 'node:test';

import { AcpConnection, AcpRpcError, RPC_METHOD_NOT_FOUND } from '../dsh-acp-connection.js';

/** A connection wired to an in-memory agent: `agent.say` writes agent lines. */
function wire(handlers: { onNotification?: (m: string, p: any) => void, onRequest?: (m: string, p: any) => unknown } = {}) {
  const agentOut = new PassThrough();
  const sent: any[] = [];
  const output = { write: (chunk: string) => { for (const line of chunk.split('\n').filter(Boolean)) sent.push(JSON.parse(line)); } };
  const connection = new AcpConnection({ input: agentOut, output, ...handlers });
  return { connection, sent, say: (msg: unknown) => agentOut.write(`${typeof msg === 'string' ? msg : JSON.stringify(msg)}\n`) };
}
const tick = () => new Promise((resolve) => setImmediate(resolve));

describe('AcpConnection', () => {
  it('correlates answers to requests by id, out of order', async () => {
    const { connection, sent, say } = wire();
    const first = connection.request('initialize', { protocolVersion: 1 });
    const second = connection.request('session/new', { cwd: '/w' });
    assert.deepEqual(sent.map((m) => [m.id, m.method]), [[1, 'initialize'], [2, 'session/new']]);
    say({ jsonrpc: '2.0', id: 2, result: { sessionId: 's' } });
    say({ jsonrpc: '2.0', id: 1, result: { protocolVersion: 1 } });
    assert.deepEqual(await second, { sessionId: 's' });
    assert.deepEqual(await first, { protocolVersion: 1 });
  });

  it('rejects with AcpRpcError on an error answer', async () => {
    const { connection, say } = wire();
    const pending = connection.request('session/resume', {});
    say({ jsonrpc: '2.0', id: 1, error: { code: -32602, message: 'session is not resumable' } });
    await assert.rejects(pending, (error: AcpRpcError) => error instanceof AcpRpcError && error.rpcCode === -32602);
  });

  it('routes notifications, answers agent requests, and ignores non-JSON lines', async () => {
    const seen: string[] = [];
    const { sent, say } = wire({
      onNotification: (method) => seen.push(method),
      onRequest: (method) => {
        if (method === 'session/request_permission') return { outcome: { outcome: 'cancelled' } };
        throw Object.assign(new Error('nope'), { rpcCode: RPC_METHOD_NOT_FOUND });
      },
    });
    say('not json at all');
    say({ jsonrpc: '2.0', method: 'session/update', params: { update: {} } });
    say({ jsonrpc: '2.0', id: 0, method: 'session/request_permission', params: {} });
    say({ jsonrpc: '2.0', id: 7, method: 'fs/read_text_file', params: {} });
    await tick();
    await tick();
    assert.deepEqual(seen, ['session/update']);
    assert.deepEqual(sent.find((m) => m.id === 0)?.result, { outcome: { outcome: 'cancelled' } });
    assert.equal(sent.find((m) => m.id === 7)?.error?.code, RPC_METHOD_NOT_FOUND);
  });

  it('close rejects every pending request and refuses new ones', async () => {
    const { connection } = wire();
    const pending = connection.request('session/prompt', {});
    connection.close(new Error('dsh exited'));
    await assert.rejects(pending, /dsh exited/);
    await assert.rejects(connection.request('initialize'), /dsh exited/);
  });
});
