/**
 * ADR-226: the nassaj OpenCode plugin is a channel client. Driven in a child process (the
 * plugin opens fd 3 at load) whose fd 3 is a socketpair this test answers as the server.
 */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { OPENCODE_PARITY_PROTOCOL } from '../../modules/providers/list/opencode/opencode-parity-runtime.js';
import { argumentHash } from '../../services/permission-parity/parity-broker.js';
import * as pluginModule from './nassaj-claude-parity.js';

type Row = Record<string, any>;
const PLUGIN = path.join(path.dirname(fileURLToPath(import.meta.url)), 'nassaj-claude-parity.js');
const dir = fs.mkdtempSync(path.join(fs.realpathSync('/var/tmp'), 'oc-parity-plugin-'));
after(() => fs.rmSync(dir, { recursive: true, force: true }));

/** Runs the plugin's hooks in a child; `steps` are hook calls, `server` answers fd 3 frames. */
const DRIVER = `
const { NassajClaudeParity } = await import(${JSON.stringify(pathToFileURL(PLUGIN).href)});
const steps = JSON.parse(process.argv[2]);
const hooks = await NassajClaudeParity();
const results = [];
for (const step of steps) {
  try {
    if (step.hook === 'before') {
      const output = { args: step.args };
      await hooks['tool.execute.before'](step.input, output);
      let mutationThrew = false;
      try { output.args.command = 'MUTATED'; } catch { mutationThrew = true; }
      let replaceThrew = false;
      try { output.args = { command: 'REPLACED' }; } catch { replaceThrew = true; }
      results.push({ ok: true, frozen: Object.isFrozen(output.args), mutationThrew, replaceThrew, args: output.args });
    } else if (step.hook === 'after') {
      const output = { output: 'body' };
      await hooks['tool.execute.after'](step.input, output);
      results.push({ ok: true, output: output.output });
    } else if (step.hook === 'env') {
      const output = { env: { NASSAJ_ADDED: 'x', KEEP: 'y' } };
      await hooks['shell.env']({}, output);
      results.push({ ok: true, set: Object.keys(output.env).filter((k) => output.env[k] !== undefined).sort(),
        unset: Object.keys(output.env).filter((k) => output.env[k] === undefined).sort() });
    }
  } catch (error) {
    results.push({ ok: false, error: String(error.message) });
  }
}
process.stdout.write(JSON.stringify(results));
process.exit(0);
`;
const driverFile = path.join(dir, 'driver.mjs');
fs.writeFileSync(driverFile, DRIVER);

type Server = { onHello?: (frame: Row) => Row | null; onPre?: (frame: Row) => Row; onPost?: (frame: Row) => Row; closeOnPre?: boolean };

async function drive(steps: Row[], server: Server | null, nonce = 'nonce-1') {
  const child = spawn(process.execPath, [driverFile, JSON.stringify(steps)], {
    stdio: ['ignore', 'pipe', 'inherit', server ? 'pipe' : 'ignore'],
    env: { PATH: process.env.PATH ?? '', NASSAJ_SECRET_PROBE: 'secret' },
  });
  const frames: Row[] = [];
  if (server) {
    const channel = child.stdio[3] as NodeJS.ReadWriteStream;
    channel.on('error', () => {});
    let buffer = '';
    channel.on('data', (chunk) => {
      buffer += chunk;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        const frame = JSON.parse(buffer.slice(0, at));
        buffer = buffer.slice(at + 1);
        frames.push(frame);
        if (frame.type === 'pre' && server.closeOnPre) {
          (channel as unknown as { destroy(): void }).destroy();
          return;
        }
        const reply = frame.type === 'hello' ? (server.onHello?.(frame) ?? { ok: true })
          : frame.type === 'pre' ? server.onPre?.(frame) : server.onPost?.(frame);
        if (reply) channel.write(`${JSON.stringify({ id: frame.id, ...reply })}\n`);
      }
    });
    channel.write(`${JSON.stringify({ type: 'challenge', nonce })}\n`);
  }
  let stdout = '';
  child.stdout!.on('data', (d) => { stdout += d; });
  await new Promise((resolve) => child.on('close', resolve));
  return { results: JSON.parse(stdout || '[]') as Row[], frames };
}

const bash = (command: string) => ({ hook: 'before', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1' }, args: { command, description: 'd' } });

describe('nassaj-claude-parity channel client (ADR-226)', () => {
  it('exports only the plugin function (opencode loads every export as a plugin)', () => {
    assert.deepEqual(Object.keys(pluginModule), ['NassajClaudeParity']);
  });

  it('carries the runtime protocol literal', () => {
    assert.ok(fs.readFileSync(PLUGIN, 'utf8').includes(OPENCODE_PARITY_PROTOCOL));
  });

  it('hello = the challenge nonce, its own sha256 and the protocol', async () => {
    const { frames } = await drive([], { onHello: () => ({ ok: true }) }, 'nonce-xyz');
    const hello = frames.find((f) => f.type === 'hello');
    assert.equal(hello?.nonce, 'nonce-xyz');
    assert.equal(hello?.pluginDigest, createHash('sha256').update(fs.readFileSync(PLUGIN)).digest('hex'));
    assert.equal(hello?.protocol, OPENCODE_PARITY_PROTOCOL);
  });

  it('no fd 3 (a nested opencode): every tool call is refused', async () => {
    const { results } = await drive([bash('echo hi')], null);
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /^nassaj:opencode_parity_unavailable:/);
  });

  it('a refused hello: every tool call is refused, nothing more is asked', async () => {
    const { results, frames } = await drive([bash('echo hi')], { onHello: () => ({ ok: false, code: 'parity_hello_refused' }) });
    assert.equal(results[0].ok, false);
    assert.equal(frames.filter((f) => f.type === 'pre').length, 0);
  });

  it('allow: the pre frame names the call and its hash; the args are frozen and locked', async () => {
    const { results, frames } = await drive([bash('echo hi')], { onPre: () => ({ decision: 'allow' }) });
    const pre = frames.find((f) => f.type === 'pre');
    assert.deepEqual([pre?.sessionID, pre?.callID, pre?.tool], ['ses_1', 'call_1', 'bash']);
    assert.equal(pre?.hash, argumentHash({ command: 'echo hi', description: 'd' }));
    assert.equal(results[0].ok, true);
    assert.deepEqual([results[0].frozen, results[0].mutationThrew, results[0].replaceThrew], [true, true, true]);
    assert.equal(results[0].args.command, 'echo hi');
  });

  it('deny: throws nassaj:<code>: with the engine reason verbatim', async () => {
    const { results } = await drive([bash('pm2 restart x')], { onPre: () => ({ decision: 'deny', reason: 'service-gate: blocked' }) });
    assert.equal(results[0].ok, false);
    assert.equal(results[0].error, 'nassaj:permission_denied_by_claude_rule: service-gate: blocked');
  });

  it('a channel lost while a call waits for its decision: refused', async () => {
    const { results } = await drive([bash('echo hi')], { closeOnPre: true });
    assert.equal(results[0].ok, false);
    assert.match(results[0].error, /^nassaj:opencode_parity_unavailable:/);
  });

  it('post: a PostToolUse block reason and its context are appended to the output', async () => {
    const { results, frames } = await drive([{ hook: 'after', input: { tool: 'bash', sessionID: 'ses_1', callID: 'call_1', args: { command: 'x' } } }],
      { onPost: () => ({ block: true, reason: 'post says no', additionalContext: ['ctx line'] }) });
    const post = frames.find((f) => f.type === 'post');
    assert.equal(post?.output, 'body');
    assert.equal(post?.hash, argumentHash({ command: 'x' }));
    assert.equal(results[0].output, 'body\npost says no\nctx line');
  });

  it('shell.env: every NASSAJ_* variable (inherited or added) is set to undefined, nothing else', async () => {
    const { results } = await drive([{ hook: 'env' }], null);
    assert.deepEqual(results[0].set, ['KEEP']);
    assert.deepEqual(results[0].unset, ['NASSAJ_ADDED', 'NASSAJ_SECRET_PROBE']);
  });
});
