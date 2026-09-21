/**
 * nassaj-canva integration test.
 *
 * Same shape as the Wafeq one and for the same reason: the failure mode that
 * matters is "starts, lists tools, then cannot do anything", so the server is
 * driven as a real child process over MCP rather than imported.
 *
 * No network is required. The three states asserted here are the three a member
 * can actually be in — never linked, link expired beyond repair, and a live
 * grant — and each must produce a sentence that says what to do next.
 */

import assert from 'node:assert/strict';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, describe, it } from 'node:test';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SERVER = path.join(HERE, 'canva.ts');
const TSX = path.join(HERE, '..', '..', 'node_modules', '.bin', 'tsx');

const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'canva-test-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** Boots the server, performs the handshake, calls one tool, returns the text. */
async function runOnce(
  grant: Record<string, unknown> | null,
  revocationMarker: 'intent' | 'tombstone' | null = null,
): Promise<{
  tools: string[];
  text: string;
  isError: boolean;
}> {
  const env: Record<string, string> = {
    ...process.env,
    NASSAJ_OAUTH_CANVA_CLIENT_ID: 'OC-test',
    NASSAJ_OAUTH_CANVA_CLIENT_SECRET: 'test-secret',
  };
  if (grant) {
    const file = path.join(scratch, `grant-${Math.abs(JSON.stringify(grant).length)}.json`);
    fs.writeFileSync(file, JSON.stringify(grant));
    if (revocationMarker) {
      const suffix = revocationMarker === 'intent' ? 'revocation-intent' : 'revocation-pending';
      fs.writeFileSync(`${file}.${suffix}.json`, JSON.stringify({ version: 1 }));
    }
    env.NASSAJ_GRANT_FILE = file;
  } else {
    env.NASSAJ_GRANT_FILE = path.join(scratch, 'missing.json');
  }

  const child = spawn(TSX, [SERVER], { stdio: ['pipe', 'pipe', 'pipe'], env }) as ChildProcessWithoutNullStreams;
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = '';
  let nextId = 1;

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
        // banner output
      }
    }
  });

  const call = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      const id = nextId++;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      setTimeout(() => reject(new Error(`timed out on ${method}`)), 25000).unref();
    });

  try {
    await call('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'test', version: '1' },
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`);

    const listed = (await call('tools/list', {})) as { result?: { tools?: Array<{ name: string }> } };
    const called = (await call('tools/call', {
      name: 'canva_list_designs',
      arguments: {},
    })) as { result?: { isError?: boolean; content?: Array<{ text?: string }> } };

    return {
      tools: (listed.result?.tools ?? []).map((tool) => tool.name),
      text: called.result?.content?.[0]?.text ?? '',
      isError: called.result?.isError === true,
    };
  } finally {
    child.kill();
  }
}

describe('nassaj-canva over stdio', () => {
  it('lists a read-only tool set', async () => {
    const { tools } = await runOnce(null);
    assert.equal(tools.length, 7);
    assert.ok(tools.includes('canva_list_designs'));
    assert.ok(
      tools.every((name) => /^canva_(list|get)_/.test(name)),
      `every tool must be a read: ${tools.join(', ')}`,
    );
  });

  it('tells an unlinked member to link, not that the tool failed', async () => {
    const { isError, text } = await runOnce(null);
    assert.equal(isError, true);
    assert.match(text, /اربط الحساب/);
  });

  it('tells a member whose grant expired without a refresh token to re-link', async () => {
    const { isError, text } = await runOnce({
      access_token: 'expired',
      refresh_token: null,
      expires_at: Date.now() - 60_000,
      token_url: 'https://api.canva.com/rest/v1/oauth/token',
    });
    assert.equal(isError, true);
    assert.match(text, /أعد الربط/);
  });

  it('rejects a live tool call before any Canva fetch after tombstone', async () => {
    const { isError, text } = await runOnce({
      access_token: 'must-not-be-sent',
      refresh_token: 'must-not-refresh',
      expires_at: Date.now() + 60_000,
      token_url: 'https://127.0.0.1:1/token',
    }, 'tombstone');
    assert.equal(isError, true);
    assert.match(text, /طلب إبطال/);
  });

  it('rejects a live tool call on intent alone before any final Canva fetch', async () => {
    const { isError, text } = await runOnce({
      access_token: 'must-not-be-sent',
      refresh_token: 'must-not-refresh',
      expires_at: Date.now() + 60_000,
      token_url: 'https://127.0.0.1:1/token',
    }, 'intent');
    assert.equal(isError, true);
    assert.match(text, /طلب إبطال/);
  });
});
