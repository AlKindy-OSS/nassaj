/**
 * ADR-226: the server side of an OpenCode turn — hello before the prompt, refusals, the
 * undecided-result kill, the tree kill, the L4 cage audit and the MCP server names. The
 * child is a small node script on a real fd 3 socketpair (no opencode, no model).
 */
// B-1349: FIRST import — HOME becomes a /var/tmp sandbox before anything reads it.
import '@/shared/__tests__/sandbox-home.js';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';

import { configuredOpenCodeMcpServers } from './opencode-parity-launch.js';
import {
  OPENCODE_HANDSHAKE_TIMEOUT_MS_DEFAULT,
  OPENCODE_PARITY_PROTOCOL,
  killProcessTree,
  openCodeHandshakeTimeoutMs,
  prepareOpenCodeParityTurn,
  startOpenCodeParityTurn,
} from './opencode-parity-runtime.js';

type Row = Record<string, any>;
const scratch = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'oc-parity-runtime-'));
after(() => fs.rmSync(scratch, { recursive: true, force: true }));

/** A child that plays the plugin: hello with `hello` fields (or none), then echoes stdin to a file. */
const CHILD = `
const net = require('net'); const fs = require('fs');
const [helloJson, out] = process.argv.slice(2);
const hello = JSON.parse(helloJson);
const socket = new net.Socket({ fd: 3, readable: true, writable: true });
socket.on('error', () => {});
let buffer = '';
socket.on('data', (chunk) => {
  buffer += chunk;
  const at = buffer.indexOf('\\n');
  if (at < 0) return;
  const frame = JSON.parse(buffer.slice(0, at)); buffer = '';
  if (frame.type === 'challenge' && hello) socket.write(JSON.stringify({ type: 'hello', id: 'h', nonce: hello.nonce ?? frame.nonce, pluginDigest: hello.digest, protocol: hello.protocol }) + '\\n');
});
let text = ''; process.stdin.on('data', (d) => { text += d; }); process.stdin.on('end', () => { fs.writeFileSync(out, text); process.exit(0); });
setTimeout(() => process.exit(3), 20000);
`;
const childFile = path.join(scratch, 'child.cjs');
fs.writeFileSync(childFile, CHILD);

const engine = (gate: Row = { blocked: false }) => ({
  decideTool: async () => ({ decision: 'deny' as const }),
  userPromptSubmit: async () => gate,
});

async function turn(hello: Row | null, gate?: Row, timeoutMs = 4000) {
  const out = path.join(scratch, `stdin-${Math.random()}`);
  const child = spawn(process.execPath, [childFile, JSON.stringify(hello), out], { stdio: ['pipe', 'pipe', 'inherit', 'pipe'], detached: true });
  const prepared = prepareOpenCodeParityTurn({ createEngine: () => engine(gate), mirrorHome: scratch, sessionId: null, cwd: scratch });
  const parity = startOpenCodeParityTurn(prepared, { child, pluginDigest: 'digest-1', prompt: 'the prompt', userText: 'the prompt',
    userId: null, writer: null, timeoutMs });
  const outcome = await parity.released;
  await new Promise((resolve) => child.once('exit', resolve));
  const violation = await parity.finish();
  return { outcome, violation, stdin: fs.existsSync(out) ? fs.readFileSync(out, 'utf8') : null, parity };
}

describe('startOpenCodeParityTurn', () => {
  it('an accepted hello releases the prompt over stdin, with hook context first', async () => {
    const { outcome, stdin } = await turn({ digest: 'digest-1', protocol: OPENCODE_PARITY_PROTOCOL },
      { blocked: false, additionalContext: ['hook context'] });
    assert.deepEqual(outcome, { ok: true });
    assert.equal(stdin, 'hook context\n\nthe prompt');
  });

  for (const [name, hello] of [['wrong digest', { digest: 'other', protocol: OPENCODE_PARITY_PROTOCOL }],
    ['wrong protocol', { digest: 'digest-1', protocol: 'x/1' }], ['wrong nonce', { nonce: 'n', digest: 'digest-1', protocol: OPENCODE_PARITY_PROTOCOL }]] as const) {
    it(`${name}: refused, killed, no prompt written`, async () => {
      const { outcome, stdin } = await turn(hello);
      assert.equal(outcome.ok, false);
      assert.equal(stdin, null);
    });
  }

  it('no hello within the timeout: opencode_parity_not_loaded, killed, no prompt written', async () => {
    const started = Date.now();
    const { outcome, stdin, violation } = await turn(null, undefined, 500);
    assert.deepEqual([outcome.ok, !outcome.ok && outcome.code], [false, 'opencode_parity_not_loaded']);
    assert.equal(violation, 'opencode_parity_not_loaded');
    assert.equal(stdin, null);
    assert.ok(Date.now() - started < 5000);
  });

  it('a blocking UserPromptSubmit hook: refused with the hook reason, no prompt written', async () => {
    const { outcome, stdin } = await turn({ digest: 'digest-1', protocol: OPENCODE_PARITY_PROTOCOL }, { blocked: true, reason: 'hook says no' });
    assert.deepEqual(outcome, { ok: false, code: 'opencode_prompt_blocked', message: 'hook says no' });
    assert.equal(stdin, null);
  });
});

describe('killProcessTree', () => {
  it('kills a grandchild that started its own session', async () => {
    const root = spawn('/bin/bash', ['-c', 'setsid sleep 300 & sleep 300'], { detached: true, stdio: 'ignore' });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const kids = fs.readFileSync(`/proc/${root.pid}/task/${root.pid}/children`, 'utf8').trim().split(/\s+/).map(Number);
    assert.ok(kids.length >= 1);
    await killProcessTree(root.pid);
    // A process may vanish between two /proc reads: read status once, absent = gone.
    const alive = (pid: number) => {
      try { return !/^State:\s*Z/m.test(fs.readFileSync(`/proc/${pid}/status`, 'utf8')); } catch { return false; }
    };
    const deadline = Date.now() + 2000;
    while (kids.some(alive) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 25));
    assert.deepEqual(kids.filter(alive), []);
  });

  it('ignores pids it must never signal', async () => {
    await killProcessTree(undefined);
    await killProcessTree(1);
    await killProcessTree(0);
  });
});

describe('knobs and names', () => {
  it('handshake timeout: default, and NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS overrides', () => {
    assert.equal(openCodeHandshakeTimeoutMs({}), OPENCODE_HANDSHAKE_TIMEOUT_MS_DEFAULT);
    assert.equal(openCodeHandshakeTimeoutMs({ NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS: '9000' }), 9000);
    assert.equal(openCodeHandshakeTimeoutMs({ NASSAJ_OPENCODE_HANDSHAKE_TIMEOUT_MS: 'x' }), OPENCODE_HANDSHAKE_TIMEOUT_MS_DEFAULT);
  });

  it('configured MCP server names: member file + inline config; disabled and unparseable ignored', () => {
    const home = fs.mkdtempSync(path.join(scratch, 'cfg-'));
    fs.writeFileSync(path.join(home, 'opencode.json'), JSON.stringify({ mcp: { probe: { type: 'local' }, off: { enabled: false } } }));
    fs.writeFileSync(path.join(home, 'opencode.jsonc'), '{ // comment\n "mcp": { "jsonc": {} } }');
    assert.deepEqual(configuredOpenCodeMcpServers(home, JSON.stringify({ mcp: { probe_a: {} } })), ['probe', 'probe_a']);
    assert.deepEqual(configuredOpenCodeMcpServers(path.join(home, 'missing')), []);
  });
});
