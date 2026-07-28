/**
 * codex-credentials.writer.test.ts — T-866/B4.
 *
 * Proves the Codex API-key writer drives `codex login --with-api-key` with the
 * key on STDIN ONLY (never argv — the /proc/cmdline leak), returns a clean
 * generic error on CLI failure, and deletes only the OPENAI_API_KEY field from
 * auth.json (OAuth tokens preserved). spawn is injected so no real CLI runs;
 * CODEX_HOME is pinned to a sandbox. Runner: node:test + node:assert.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, beforeEach, test } from 'node:test';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cred-writer-'));
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
process.env.CODEX_HOME = sandbox;

const { CodexCredentialsWriter } = await import('./codex-credentials.writer.js');

const authPath = path.join(sandbox, 'auth.json');
const KEY = 'sk-codex-secret-DO-NOT-LEAK';

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown>; stdin: string[] };

/**
 * Builds a fake spawn that records the argv/opts/stdin and drives the child
 * lifecycle: it emits either an 'error' or a 'close(exitCode, signal)' on the
 * next tick, after the writer has attached its listeners and written stdin.
 */
function makeFakeSpawn(outcome: { exitCode?: number; signal?: string; emitError?: boolean }) {
  const calls: SpawnCall[] = [];
  const spawnFn = (cmd: string, args: string[], opts: Record<string, unknown>) => {
    const stdin: string[] = [];
    const child = new EventEmitter() as EventEmitter & { stdin: unknown };
    child.stdin = {
      write: (c: string) => { stdin.push(c); return true; },
      end: () => {},
    };
    calls.push({ cmd, args, opts, stdin });
    setImmediate(() => {
      if (outcome.emitError) {
        child.emit('error', new Error('spawn failure'));
      } else {
        child.emit('close', outcome.exitCode ?? 0, outcome.signal ?? null);
      }
    });
    return child;
  };
  return { spawnFn, calls };
}

beforeEach(() => {
  fs.rmSync(authPath, { force: true });
});

after(() => {
  if (ORIGINAL_CODEX_HOME === undefined) delete process.env.CODEX_HOME;
  else process.env.CODEX_HOME = ORIGINAL_CODEX_HOME;
  fs.rmSync(sandbox, { recursive: true, force: true });
});

test('capability is cli_stdin', () => {
  const writer = new CodexCredentialsWriter();
  assert.deepEqual(writer.getWriterCapability(), { method: 'cli_stdin' });
});

test('setApiKey passes the key on STDIN and NEVER in argv', async () => {
  const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0 });
  const writer = new CodexCredentialsWriter(spawnFn as never);

  const result = await writer.setApiKey(null, KEY);
  assert.deepEqual(result, { provider: 'codex', configured: true });

  assert.equal(calls.length, 1, 'the login CLI was spawned exactly once');
  const call = calls[0];
  assert.equal(call.cmd, 'codex');
  assert.deepEqual(call.args, ['login', '--with-api-key'], 'fixed, secret-free argv');
  // The key must appear NOWHERE in argv (the /proc/<pid>/cmdline leak).
  assert.ok(!JSON.stringify([call.cmd, ...call.args]).includes(KEY), 'key leaked into argv');
  assert.equal(call.opts.shell, false, 'spawned without a shell');
  // The key reaches the CLI via stdin, newline-terminated.
  assert.equal(call.stdin.join(''), `${KEY}\n`);
});

test('a non-zero CLI exit rejects with a clean generic error carrying no key', async () => {
  const { spawnFn } = makeFakeSpawn({ exitCode: 1 });
  const writer = new CodexCredentialsWriter(spawnFn as never);

  await assert.rejects(
    () => writer.setApiKey(null, KEY),
    (err: unknown) => {
      const e = err as { code?: string; message?: string };
      assert.equal(e.code, 'CODEX_LOGIN_FAILED');
      assert.ok(!JSON.stringify(err).includes(KEY), 'error object leaked the key');
      return true;
    },
  );
});

test('a spawn error rejects cleanly (CLI missing / not executable)', async () => {
  const { spawnFn } = makeFakeSpawn({ emitError: true });
  const writer = new CodexCredentialsWriter(spawnFn as never);
  await assert.rejects(
    () => writer.setApiKey(null, KEY),
    (err: unknown) => (err as { code?: string }).code === 'CODEX_LOGIN_FAILED',
  );
});

test('an empty key is rejected before any spawn', async () => {
  const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0 });
  const writer = new CodexCredentialsWriter(spawnFn as never);
  await assert.rejects(
    () => writer.setApiKey(null, '  '),
    (err: unknown) => (err as { code?: string }).code === 'INVALID_API_KEY',
  );
  assert.equal(calls.length, 0, 'no CLI spawned for an invalid key');
});

test('deleteApiKey removes only OPENAI_API_KEY, preserving OAuth tokens', async () => {
  fs.writeFileSync(authPath, JSON.stringify({
    OPENAI_API_KEY: KEY,
    tokens: { id_token: 'jwt', access_token: 'at' },
  }));
  const writer = new CodexCredentialsWriter();

  const result = await writer.deleteApiKey(null);
  assert.deepEqual(result, { provider: 'codex', configured: false });
  const auth = JSON.parse(fs.readFileSync(authPath, 'utf8'));
  assert.equal('OPENAI_API_KEY' in auth, false, 'api key removed');
  assert.deepEqual(auth.tokens, { id_token: 'jwt', access_token: 'at' }, 'OAuth tokens preserved');
});

test('isConfigured reflects the OPENAI_API_KEY presence in auth.json', async () => {
  const writer = new CodexCredentialsWriter();
  assert.equal(await writer.isConfigured(null), false);
  fs.writeFileSync(authPath, JSON.stringify({ OPENAI_API_KEY: KEY }));
  assert.equal(await writer.isConfigured(null), true);
});
