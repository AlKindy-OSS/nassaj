/**
 * provider-api-key.no-log-leak.test.ts — T-866/B6.
 *
 * The security invariant "a key value never reaches the logs" is proven by
 * capturing ALL console output across the api-key lifecycle — success AND
 * failure — and asserting the secret never appears. Coverage spans the full
 * save path (route -> service -> writer) across ALL FOUR credential surfaces:
 *   - the vendor route (kimi) set/delete, success and empty-key failure (the
 *     transport + service path, DB-free via the encrypted store);
 *   - the codex writer's CLI-failure path, the one credential path that
 *     deliberately logs a structured diagnostic — proving even THAT line omits
 *     the key; and
 *   - a full set + delete lifecycle driven directly through each of the four
 *     writers (claude / opencode / codex vendor-less + vendor), so the invariant
 *     is asserted for every writer, not only the ones that log.
 * Every writer target (CLAUDE_CONFIG_DIR / XDG_DATA_HOME / CODEX_HOME) is pinned
 * into a sandbox so the run is hermetic and never touches an operator tree.
 * Runner: node:test + node:assert.
 */

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { after, before, test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import providerRoutes from '@/modules/providers/provider.routes.js';
import { ClaudeCredentialsWriter } from '@/modules/providers/list/claude/claude-credentials.writer.js';
import { CodexCredentialsWriter } from '@/modules/providers/list/codex/codex-credentials.writer.js';
import { OpenCodeCredentialsWriter } from '@/modules/providers/list/opencode/opencode-credentials.writer.js';
import { _resetProviderSecretsServerKeyCache } from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

const KEY = 'sk-lifecycle-secret-DO-NOT-LEAK-9999';
const TEST_SERVER_KEY = Buffer.alloc(32, 9).toString('base64');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sandboxHome = '';
const realHomedir = os.homedir;
let originalServerKeyEnv: string | undefined;

/** Captures every console.* call; returns a restore fn and the collected text. */
function captureConsole() {
  const lines: string[] = [];
  const record = (...args: unknown[]) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a))).join(' '));
  };
  const original = { log: console.log, info: console.info, warn: console.warn, error: console.error };
  console.log = record;
  console.info = record;
  console.warn = record;
  console.error = record;
  return {
    lines,
    restore() {
      console.log = original.log;
      console.info = original.info;
      console.warn = original.warn;
      console.error = original.error;
    },
  };
}

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('x-test-user');
    if (header) {
      (req as Request & { user?: { id: string } }).user = { id: header };
    }
    next();
  });
  app.use('/api/providers', providerRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({ success: false, error: { code: err.code, message: err.message } });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
  return app;
}

async function call(method: string, routePath: string, user: string, body?: unknown) {
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  return { status: res.status };
}

before(async () => {
  sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'no-log-leak-'));
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  originalServerKeyEnv = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_SERVER_KEY;
  _resetProviderSecretsServerKeyCache();

  const app = buildApp();
  await new Promise<void>((resolve) => { server = app.listen(0, () => resolve()); });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (os as unknown as { homedir: () => string }).homedir = realHomedir;
  if (originalServerKeyEnv === undefined) delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  else process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalServerKeyEnv;
  _resetProviderSecretsServerKeyCache();
  await fs.rm(sandboxHome, { recursive: true, force: true });
});

test('vendor set/delete (success + failure) never write the key to the logs', async () => {
  const cap = captureConsole();
  try {
    // success set
    assert.equal((await call('POST', '/api/providers/kimi/api-key', 'u1', { apiKey: KEY })).status, 200);
    // failure set (empty key)
    assert.equal((await call('POST', '/api/providers/kimi/api-key', 'u1', { apiKey: '   ' })).status, 400);
    // success delete
    assert.equal((await call('DELETE', '/api/providers/kimi/api-key', 'u1')).status, 200);
    // failure delete (unsupported provider id shape handled by parseProvider → 400)
    assert.equal((await call('DELETE', '/api/providers/bogusprovider/api-key', 'u1')).status, 400);
  } finally {
    cap.restore();
  }
  const joined = cap.lines.join('\n');
  assert.ok(!joined.includes(KEY), 'the key value leaked into a console line');
});

test('codex writer CLI-failure log line omits the key', async () => {
  // The codex writer is the only credential path that logs on failure. Drive a
  // failing spawn and assert its structured diagnostic carries no key material.
  const spawnFn = (_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: unknown };
    child.stdin = { write: () => true, end: () => {} };
    setImmediate(() => child.emit('close', 1, null));
    return child;
  };
  const writer = new CodexCredentialsWriter(spawnFn as never);

  const cap = captureConsole();
  try {
    await assert.rejects(() => writer.setApiKey(null, KEY));
  } finally {
    cap.restore();
  }
  const joined = cap.lines.join('\n');
  assert.ok(joined.length > 0, 'the failure path did log a diagnostic');
  assert.ok(!joined.includes(KEY), 'the codex failure log leaked the key');
});

test('every credential writer keeps the key out of logs across a set + delete lifecycle', async () => {
  // Pin the three file-backed writer targets into the sandbox so the writes are
  // hermetic regardless of the runner's ambient XDG/CODEX env. os.homedir is
  // already mocked to sandboxHome (before hook), which covers claude's
  // ~/.claude fallback; opencode keys off XDG_DATA_HOME and codex off CODEX_HOME.
  const originalXdg = process.env.XDG_DATA_HOME;
  const originalCodexHome = process.env.CODEX_HOME;
  process.env.XDG_DATA_HOME = path.join(sandboxHome, '.local', 'share');
  process.env.CODEX_HOME = path.join(sandboxHome, '.codex');

  // codex reaches its native store through the CLI; inject a spawn that succeeds
  // (close 0) so setApiKey resolves without a real codex binary.
  const okSpawn = (_cmd: string, _args: string[]) => {
    const child = new EventEmitter() as EventEmitter & { stdin: unknown };
    child.stdin = { write: () => true, end: () => {} };
    setImmediate(() => child.emit('close', 0, null));
    return child;
  };

  // The four credential surfaces: three facet writers (claude/opencode/codex)
  // plus the vendor path, exercised end-to-end via its route below.
  const writers = [
    new ClaudeCredentialsWriter(),
    new OpenCodeCredentialsWriter(),
    new CodexCredentialsWriter(okSpawn as never),
  ];

  const cap = captureConsole();
  try {
    for (const writer of writers) {
      const set = await writer.setApiKey(null, KEY);
      // The status object the service returns to the route must be key-free too.
      assert.ok(!JSON.stringify(set).includes(KEY), 'a writer echoed the key in its status');
      const del = await writer.deleteApiKey(null);
      assert.ok(!JSON.stringify(del).includes(KEY), 'a writer echoed the key on delete');
    }
    // Fourth surface: the vendor writer, driven through the real route/service.
    assert.equal((await call('POST', '/api/providers/kimi/api-key', 'u2', { apiKey: KEY })).status, 200);
    assert.equal((await call('DELETE', '/api/providers/kimi/api-key', 'u2')).status, 200);
  } finally {
    cap.restore();
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    if (originalCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = originalCodexHome;
  }

  const joined = cap.lines.join('\n');
  assert.ok(!joined.includes(KEY), 'a credential writer leaked the key into a console line');
});
