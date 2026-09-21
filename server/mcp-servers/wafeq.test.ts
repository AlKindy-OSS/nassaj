/**
 * nassaj-wafeq integration test.
 *
 * Runs the server as a real child process and speaks MCP to it over stdio,
 * because that is the only thing that proves what matters: that an engine can
 * launch it, hand it a tool call, and get an answer. Importing the module and
 * calling its functions would prove none of it — the whole class of bugs this
 * connector suffered was "starts, lists tools, then fails on the first call".
 *
 * The network is not touched: with no key the first call must come back as a
 * readable refusal, which is also the exact message an operator sees when they
 * forget the .env line.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'wafeq.ts');
const TSX = path.join(HERE, '..', '..', 'node_modules', '.bin', 'tsx');

let child: ChildProcessWithoutNullStreams;
let buffer = '';
const pending = new Map<number, (message: Record<string, unknown>) => void>();
let nextId = 1;

function send(method: string, params: unknown): Promise<Record<string, unknown>> {
  const id = nextId++;
  return new Promise((resolve, reject) => {
    pending.set(id, resolve);
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
    setTimeout(() => reject(new Error(`timed out waiting for ${method}`)), 20000).unref();
  });
}

before(async () => {
  child = spawn(TSX, [SERVER], {
    stdio: ['pipe', 'pipe', 'pipe'],
    // Explicitly WITHOUT a key, whatever the developer's shell holds.
    env: { ...process.env, WAFEQ_API_KEY: '' },
  }) as ChildProcessWithoutNullStreams;

  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
      if (!line) continue;
      try {
        const message = JSON.parse(line) as { id?: number };
        if (typeof message.id === 'number') {
          pending.get(message.id)?.(message as Record<string, unknown>);
          pending.delete(message.id);
        }
      } catch {
        // Not a JSON-RPC line; the transport ignores it and so do we.
      }
    }
  });

  const init = (await send('initialize', {
    protocolVersion: '2024-11-05',
    capabilities: {},
    clientInfo: { name: 'test', version: '1' },
  })) as { result?: { serverInfo?: { name?: string } } };
  assert.equal(init.result?.serverInfo?.name, 'nassaj-wafeq');
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);
});

after(() => {
  child?.kill();
});

describe('nassaj-wafeq over stdio', () => {
  it('advertises the read-only tool set', async () => {
    const listed = (await send('tools/list', {})) as {
      result?: { tools?: Array<{ name: string; inputSchema?: unknown }> };
    };
    const names = (listed.result?.tools ?? []).map((tool) => tool.name);

    assert.ok(names.includes('wafeq_list_accounts'), 'chart of accounts is the headline tool');
    assert.ok(names.includes('wafeq_get_organization'));
    assert.equal(names.length, 7);
    // Read-only is a promise this test keeps: any tool that writes has to change
    // this assertion, which is the moment to ask about financial controls.
    assert.ok(
      names.every((name) => /^wafeq_(list|get)_/.test(name)),
      `every tool must be a read: ${names.join(', ')}`,
    );
  });

  it('refuses readably when no key is configured', async () => {
    const called = (await send('tools/call', {
      name: 'wafeq_list_accounts',
      arguments: { page_size: 3 },
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    assert.equal(called.result?.isError, true);
    assert.match(called.result?.content?.[0]?.text ?? '', /WAFEQ_API_KEY/);
  });

  it('rejects an unknown tool instead of answering something', async () => {
    const called = (await send('tools/call', {
      name: 'wafeq_delete_everything',
      arguments: {},
    })) as { error?: unknown; result?: { isError?: boolean } };

    assert.ok(called.error || called.result?.isError, 'an unknown tool must not succeed');
  });
});
