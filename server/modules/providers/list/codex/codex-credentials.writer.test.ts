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

import { createCodexMachineFixture } from '@/shared/tests/codex-release-fixture.js';

import { emulateCodexCliLogin } from '../../tests/codex-cli-login.fixture.js';
import { principal } from '../../tests/codex-credential-principal.fixture.js';

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cred-writer-'));
const ORIGINAL_CODEX_HOME = process.env.CODEX_HOME;
process.env.CODEX_HOME = sandbox;

const { CodexCredentialsWriter } = await import('./codex-credentials.writer.js');
// T-1872: `codex login` runs the machine release (a fixture here), never PATH.
const codexMachine = createCodexMachineFixture(path.join(sandbox, 'codex-machine'));
process.env.CODEX_PATH = codexMachine.launcher;

const authPath = path.join(sandbox, 'auth.json');
const KEY = 'sk-codex-secret-DO-NOT-LEAK';

type SpawnCall = { cmd: string; args: string[]; opts: Record<string, unknown>; stdin: string[] };

/**
 * Builds a fake spawn that records the argv/opts/stdin and drives the child
 * lifecycle: it emits either an 'error' or a 'close(exitCode, signal)' on the
 * next tick, after the writer has attached its listeners and written stdin.
 */
function makeFakeSpawn(outcome: {
  exitCode?: number; signal?: string; emitError?: boolean; writes?: boolean;
}) {
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
        // A successful login leaves what the measured CLI writes (ADR-200 S3).
        if ((outcome.exitCode ?? 0) === 0 && !outcome.signal && outcome.writes !== false) {
          emulateCodexCliLogin(opts, stdin.join(''));
        }
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

  const result = await writer.setApiKey(1, KEY, undefined, principal);
  assert.deepEqual(result, { provider: 'codex', configured: true });

  assert.equal(calls.length, 1, 'the login CLI was spawned exactly once');
  const call = calls[0];
  assert.equal(call.cmd, path.join(fs.realpathSync(codexMachine.release), 'bin', 'codex'));
  assert.ok(path.isAbsolute(call.cmd), 'the login executable must have an explicit resolved path');
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
    () => writer.setApiKey(1, KEY, undefined, principal),
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
    () => writer.setApiKey(1, KEY, undefined, principal),
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

// ---------------------------------------------------------------------------
// ADR-200 S3 — Codex measurement and writer (T-1976).
//
// Recorded measurement (codex-cli 0.160.0; throwaway CODEX_HOME under /var/tmp;
// dummy values only; no real credential, no network):
//   printf '<dummy key>\n' | env -i PATH=/usr/bin:/bin HOME=<tmp> CODEX_HOME=<tmp>/.codex \
//     ~/.local/bin/codex login --with-api-key
//   before: {"auth_mode":"chatgpt","OPENAI_API_KEY":null,
//            "tokens":{"id_token":<r>,"access_token":<r>,"refresh_token":<r>,"account_id":<r>},
//            "last_refresh":<r>}
//   after:  {"auth_mode":"apikey","OPENAI_API_KEY":<r>}      ← tokens WIPED
// So with `tokens` present the writer must merge, never spawn the CLI.
// ---------------------------------------------------------------------------

const { resolveCodexEffectiveAuth } = await import('./codex-auth.provider.js');

const TOKENS = {
  id_token: 'header.eyJlbWFpbCI6ImR1bW15QGV4YW1wbGUuaW52YWxpZCJ9.sig',
  access_token: 'DUMMY-ACCESS',
  refresh_token: 'DUMMY-REFRESH',
  account_id: 'DUMMY-ACCOUNT',
};

/** The ChatGPT-login shape the CLI writes: 2-space JSON, no trailing newline. */
const cliOAuthBytes = (): string => JSON.stringify({
  auth_mode: 'chatgpt',
  OPENAI_API_KEY: null,
  tokens: TOKENS,
  last_refresh: '2026-01-01T00:00:00Z',
}, null, 2);

const readAuth = (): Record<string, unknown> => JSON.parse(fs.readFileSync(authPath, 'utf8'));

test('S3: set over an OAuth auth.json merges the key and never spawns the wiping CLI', async () => {
  fs.writeFileSync(authPath, cliOAuthBytes());
  const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0 });
  await new CodexCredentialsWriter(spawnFn as never).setApiKey(1, KEY, undefined, principal);
  assert.equal(calls.length, 0, 'codex login would wipe tokens — it must not run');
  const auth = readAuth();
  assert.equal(auth.auth_mode, 'apikey');
  assert.equal(auth.OPENAI_API_KEY, KEY);
  assert.equal(JSON.stringify(auth.tokens), JSON.stringify(TOKENS), 'tokens byte-identical');
  assert.equal(auth.last_refresh, '2026-01-01T00:00:00Z');
  assert.equal(resolveCodexEffectiveAuth(auth), 'api_key', 'the key is what runs now');
  assert.equal(fs.statSync(authPath).mode & 0o777, 0o600);
});

test('S3: OAuth file → set key → delete key leaves the file byte-for-byte identical', async () => {
  const original = cliOAuthBytes();
  fs.writeFileSync(authPath, original);
  const writer = new CodexCredentialsWriter(makeFakeSpawn({ exitCode: 0 }).spawnFn as never);
  await writer.setApiKey(1, KEY, undefined, principal);
  assert.notEqual(fs.readFileSync(authPath, 'utf8'), original);
  await writer.deleteApiKey(1);
  assert.equal(fs.readFileSync(authPath, 'utf8'), original);
  assert.equal(resolveCodexEffectiveAuth(readAuth()), 'subscription', 'OAuth runs again');
});

test('S3: a legacy OAuth file (no auth_mode, trailing newline) also round-trips exactly', async () => {
  const original = `${JSON.stringify({ tokens: TOKENS, last_refresh: 'x' }, null, 2)}\n`;
  fs.writeFileSync(authPath, original);
  const writer = new CodexCredentialsWriter(makeFakeSpawn({ exitCode: 0 }).spawnFn as never);
  await writer.setApiKey(1, KEY, undefined, principal);
  assert.equal('auth_mode' in readAuth(), false, 'no mode invented: a non-null key already wins');
  assert.equal(resolveCodexEffectiveAuth(readAuth()), 'api_key');
  await writer.deleteApiKey(1);
  assert.equal(fs.readFileSync(authPath, 'utf8'), original);
});

test('B-1574: a login holding only a refresh token gets auth_mode "chatgpt" back after the key delete', async () => {
  const original = JSON.stringify({ auth_mode: 'chatgpt', OPENAI_API_KEY: null, tokens: { refresh_token: 'rt', account_id: 'acc' } }, null, 2);
  fs.writeFileSync(authPath, original);
  const writer = new CodexCredentialsWriter(makeFakeSpawn({ exitCode: 0 }).spawnFn as never);
  await writer.setApiKey(1, KEY, undefined, principal);
  assert.equal(readAuth().auth_mode, 'apikey');
  await writer.deleteApiKey(1);
  assert.equal(readAuth().auth_mode, 'chatgpt', 'never left empty while tokens remain');
  assert.equal(fs.readFileSync(authPath, 'utf8'), original);
});

test('B-1574: with no tokens left the key delete drops the apikey mode', async () => {
  fs.writeFileSync(authPath, JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: KEY, tokens: {} }));
  await new CodexCredentialsWriter(makeFakeSpawn({ exitCode: 0 }).spawnFn as never).deleteApiKey(1);
  assert.deepEqual(readAuth(), { tokens: {} });
});

// G1 M-3: bytes that differ from what the merge wrote are someone else's change;
// the rollback is compare-and-restore, so they are refused, not overwritten.
test('S3: a merge whose file was changed under it is refused and left as found', async (t) => {
  const original = cliOAuthBytes();
  fs.writeFileSync(authPath, original);
  const foreign = JSON.stringify({ auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  const realRename = fs.renameSync;
  let first = true;
  t.mock.method(fs, 'renameSync', (from: fs.PathLike, to: fs.PathLike) => {
    realRename(from, to);
    if (first && to === authPath) {
      first = false; // Another writer replaces the file right after ours.
      fs.writeFileSync(authPath, foreign);
    }
  });
  const writer = new CodexCredentialsWriter(makeFakeSpawn({ exitCode: 0 }).spawnFn as never);
  await assert.rejects(writer.setApiKey(1, KEY, undefined, principal), (error: unknown) => {
    assert.equal((error as { code?: string }).code, 'CODEX_AUTH_CHANGED_CONCURRENTLY');
    assert.ok(!JSON.stringify(error).includes(KEY), 'error leaked the key');
    return true;
  });
  t.mock.restoreAll();
  assert.equal(fs.readFileSync(authPath, 'utf8'), foreign, 'the other writer’s bytes are not overwritten');
});

test('S3: a CLI login that exits 0 but leaves no key fails verification', async () => {
  const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0, writes: false });
  await assert.rejects(
    new CodexCredentialsWriter(spawnFn as never).setApiKey(1, KEY, undefined, principal),
    (error: unknown) => (error as { code?: string }).code === 'CODEX_AUTH_VERIFY_FAILED',
  );
  assert.equal(calls.length, 1);
});

test('S3: without tokens the CLI login still runs and is verified', async () => {
  const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0 });
  await new CodexCredentialsWriter(spawnFn as never).setApiKey(1, KEY, undefined, principal);
  assert.equal(calls.length, 1);
  assert.deepEqual(readAuth(), { auth_mode: 'apikey', OPENAI_API_KEY: KEY });
  await new CodexCredentialsWriter().deleteApiKey(1);
  assert.deepEqual(readAuth(), {}, 'key-only file: key and its mode removed');
});

test('S3: an unreadable auth.json is refused for set and delete and left untouched', async () => {
  fs.writeFileSync(authPath, '{"tokens": {broken');
  const { spawnFn, calls } = makeFakeSpawn({ exitCode: 0 });
  const writer = new CodexCredentialsWriter(spawnFn as never);
  const unreadable = (error: unknown) => (error as { code?: string }).code === 'CODEX_AUTH_UNREADABLE';
  await assert.rejects(writer.setApiKey(1, KEY, undefined, principal), unreadable);
  await assert.rejects(writer.deleteApiKey(1), unreadable);
  assert.equal(calls.length, 0);
  assert.equal(fs.readFileSync(authPath, 'utf8'), '{"tokens": {broken');
});

test('S3: concurrent set/delete serialize under the per-file lock (L4)', async () => {
  const original = cliOAuthBytes();
  fs.writeFileSync(authPath, original);
  const writer = new CodexCredentialsWriter(makeFakeSpawn({ exitCode: 0 }).spawnFn as never);
  await Promise.all([
    writer.setApiKey(1, KEY, undefined, principal),
    writer.deleteApiKey(1),
    writer.setApiKey(1, `${KEY}-2`, undefined, principal),
    writer.deleteApiKey(1),
  ]);
  assert.equal(fs.readFileSync(authPath, 'utf8'), original, 'last op (delete) wins, in order');
  assert.equal(fs.existsSync(`${authPath}.nassaj-lock`), false, 'lock file released');
});

test('S3: a lock file left by a dead process is reclaimed', async () => {
  fs.writeFileSync(authPath, cliOAuthBytes());
  fs.writeFileSync(`${authPath}.nassaj-lock`, JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now(), token: 'x' }));
  await new CodexCredentialsWriter().setApiKey(1, KEY, undefined, principal);
  assert.equal(readAuth().OPENAI_API_KEY, KEY);
  assert.equal(fs.existsSync(`${authPath}.nassaj-lock`), false);
});

const { writeCodexAuthVerified } = await import('./codex-credentials.writer.js');

test('G1 M-3: a failed verify restores the previous bytes when the file is still ours', () => {
  const original = cliOAuthBytes();
  fs.writeFileSync(authPath, original);
  const before = { raw: original, auth: JSON.parse(original), trailingNewline: false };
  // Write key A but verify against key B: verification fails on our own bytes.
  assert.throws(
    () => writeCodexAuthVerified(authPath, before, { ...before.auth, OPENAI_API_KEY: 'sk-A' }, 'sk-B'),
    { code: 'CODEX_AUTH_VERIFY_FAILED' },
  );
  assert.equal(fs.readFileSync(authPath, 'utf8'), original, 'previous bytes restored');
});

test('G1 M-3: a concurrent token refresh is never wiped by the rollback', () => {
  const original = cliOAuthBytes();
  fs.writeFileSync(authPath, original);
  const before = { raw: original, auth: JSON.parse(original), trailingNewline: false };
  const refreshed = JSON.stringify({ ...JSON.parse(original), tokens: { ...TOKENS, access_token: 'refreshed' } });
  assert.throws(
    () => writeCodexAuthVerified(authPath, before, { ...before.auth, auth_mode: 'apikey', OPENAI_API_KEY: KEY }, KEY, {
      afterWrite: () => fs.writeFileSync(authPath, refreshed),
    }),
    { code: 'CODEX_AUTH_CHANGED_CONCURRENTLY' },
  );
  assert.equal(fs.readFileSync(authPath, 'utf8'), refreshed, 'the refreshed tokens are left in place');
});
