/**
 * provider-api-key.routes.test.ts — HTTP-level coverage for the vendor API-key
 * management routes mounted under /api/providers (provider.routes.ts).
 *
 * The routes are exercised end-to-end through a real Express app (the production
 * router + express.json + a fake auth middleware that mirrors authenticateToken
 * by setting req.user from a header). The encrypted secrets store writes under
 * os.homedir(); we sandbox homedir to a temp dir and pin the AES key via env so
 * the suite never touches the operator's real home and is hermetic.
 *
 * Coverage:
 *  - set then status → configured:true; the response never leaks the key value.
 *  - delete then status → configured:false (idempotent).
 *  - PUT behaves like POST (upsert).
 *  - per-user isolation: user A's key is invisible to user B.
 *  - the value is never present in any response body (set/get/list/auth-status).
 *  - setting a key flips GET /:provider/auth/status to authenticated:true.
 *  - whitelist + empty-key validation return 400.
 */

import assert from 'node:assert/strict';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';
import { after, before, beforeEach, test } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

import providerRoutes from '@/modules/providers/provider.routes.js';
import { _resetProviderSecretsServerKeyCache } from '@/services/isolation/provider-secrets-store.js';
import { AppError } from '@/shared/utils.js';

const TEST_API_KEY = 'sk-vendor-secret-DO-NOT-LEAK-1234567890';
// Deterministic 32-byte AES key (base64) so the store never writes a key file
// into the sandbox and decryption is stable across the run.
const TEST_SERVER_KEY = Buffer.alloc(32, 7).toString('base64');

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sandboxHome = '';
const realHomedir = os.homedir;
let originalServerKeyEnv: string | undefined;

/**
 * Builds the app the way index.js mounts it, except authenticateToken is replaced
 * by a header-driven stub: `x-test-user: <id>` sets req.user.id; absent → no user
 * (single-operator / shared-store path). This isolates the routes under test from
 * JWT/DB concerns while preserving the exact req.user contract they depend on.
 */
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
  // Mirror index.js global error middleware so AppError maps to its real
  // { success:false, error:{ code, message } } envelope and status code.
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: 'Internal server error' } });
  });
  return app;
}

type ApiResponse = {
  status: number;
  body: { success?: boolean; data?: unknown; error?: { code?: string; message?: string } };
};

async function call(
  method: string,
  routePath: string,
  options: { user?: string; body?: unknown } = {},
): Promise<ApiResponse> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (options.user) {
    headers['x-test-user'] = options.user;
  }
  const res = await fetch(`${baseUrl}${routePath}`, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  return { status: res.status, body };
}

before(async () => {
  sandboxHome = await fs.mkdtemp(path.join(os.tmpdir(), 'provider-keys-routes-'));
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  originalServerKeyEnv = process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_SERVER_KEY;
  _resetProviderSecretsServerKeyCache();

  const app = buildApp();
  await new Promise<void>((resolve) => {
    server = app.listen(0, () => resolve());
  });
  const address = server.address() as AddressInfo;
  baseUrl = `http://127.0.0.1:${address.port}`;
});

beforeEach(async () => {
  // Start each test from an empty store so cases never bleed into one another.
  await fs.rm(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
  await fs.rm(path.join(sandboxHome, '.nassaj-provider-secrets'), { recursive: true, force: true });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  (os as unknown as { homedir: () => string }).homedir = realHomedir;
  if (originalServerKeyEnv === undefined) {
    delete process.env.NASSAJ_PROVIDER_SECRETS_KEY;
  } else {
    process.env.NASSAJ_PROVIDER_SECRETS_KEY = originalServerKeyEnv;
  }
  _resetProviderSecretsServerKeyCache();
  await fs.rm(sandboxHome, { recursive: true, force: true });
});

test('POST sets a key then GET reports configured:true without leaking the value', async () => {
  const set = await call('POST', '/api/providers/kimi/api-key', { user: 'u1', body: { apiKey: TEST_API_KEY } });
  assert.equal(set.status, 200);
  assert.equal(set.body.success, true);
  assert.deepEqual(set.body.data, { provider: 'kimi', configured: true });
  // The set response must not echo the secret anywhere.
  assert.ok(!JSON.stringify(set.body).includes(TEST_API_KEY), 'set response leaked the key');

  const status = await call('GET', '/api/providers/kimi/api-key', { user: 'u1' });
  assert.equal(status.status, 200);
  assert.deepEqual(status.body.data, { provider: 'kimi', configured: true });
  assert.ok(!JSON.stringify(status.body).includes(TEST_API_KEY), 'status response leaked the key');
});

test('DELETE removes the key then GET reports configured:false (idempotent)', async () => {
  await call('POST', '/api/providers/deepseek/api-key', { user: 'u1', body: { apiKey: TEST_API_KEY } });

  const del = await call('DELETE', '/api/providers/deepseek/api-key', { user: 'u1' });
  assert.equal(del.status, 200);
  assert.deepEqual(del.body.data, { provider: 'deepseek', configured: false });

  const status = await call('GET', '/api/providers/deepseek/api-key', { user: 'u1' });
  assert.deepEqual(status.body.data, { provider: 'deepseek', configured: false });

  // Deleting again is a no-op, still configured:false (idempotent contract).
  const delAgain = await call('DELETE', '/api/providers/deepseek/api-key', { user: 'u1' });
  assert.equal(delAgain.status, 200);
  assert.deepEqual(delAgain.body.data, { provider: 'deepseek', configured: false });
});

test('PUT upserts the key exactly like POST', async () => {
  const put = await call('PUT', '/api/providers/glm/api-key', { user: 'u1', body: { apiKey: TEST_API_KEY } });
  assert.equal(put.status, 200);
  assert.deepEqual(put.body.data, { provider: 'glm', configured: true });

  const status = await call('GET', '/api/providers/glm/api-key', { user: 'u1' });
  assert.deepEqual(status.body.data, { provider: 'glm', configured: true });
});

test('keys are isolated per user: A is configured, B is not', async () => {
  await call('POST', '/api/providers/kimi/api-key', { user: 'userA', body: { apiKey: TEST_API_KEY } });

  const a = await call('GET', '/api/providers/kimi/api-key', { user: 'userA' });
  assert.deepEqual(a.body.data, { provider: 'kimi', configured: true });

  const b = await call('GET', '/api/providers/kimi/api-key', { user: 'userB' });
  assert.deepEqual(b.body.data, { provider: 'kimi', configured: false }, 'user B must not see user A key');

  // Deleting B (who has none) must not affect A.
  await call('DELETE', '/api/providers/kimi/api-key', { user: 'userB' });
  const aStill = await call('GET', '/api/providers/kimi/api-key', { user: 'userA' });
  assert.deepEqual(aStill.body.data, { provider: 'kimi', configured: true }, 'A key wrongly removed by B delete');
});

test('setting a key flips GET /:provider/auth/status to authenticated:true', async () => {
  const before = await call('GET', '/api/providers/kimi/auth/status', { user: 'u1' });
  assert.equal(before.status, 200);
  assert.equal((before.body.data as { authenticated: boolean }).authenticated, false);

  await call('POST', '/api/providers/kimi/api-key', { user: 'u1', body: { apiKey: TEST_API_KEY } });

  const afterSet = await call('GET', '/api/providers/kimi/auth/status', { user: 'u1' });
  const data = afterSet.body.data as { authenticated: boolean; installed: boolean; provider: string };
  assert.equal(data.authenticated, true, 'auth status must report authenticated after a key is set');
  assert.equal(data.installed, true);
  assert.equal(data.provider, 'kimi');
  // auth/status must never carry the secret either.
  assert.ok(!JSON.stringify(afterSet.body).includes(TEST_API_KEY), 'auth/status leaked the key');
});

test('the secret value never appears in any response body across the lifecycle', async () => {
  const responses = [
    await call('POST', '/api/providers/glm/api-key', { user: 'u1', body: { apiKey: TEST_API_KEY } }),
    await call('GET', '/api/providers/glm/api-key', { user: 'u1' }),
    await call('GET', '/api/providers/glm/auth/status', { user: 'u1' }),
    await call('DELETE', '/api/providers/glm/api-key', { user: 'u1' }),
    await call('GET', '/api/providers/glm/api-key', { user: 'u1' }),
  ];
  for (const res of responses) {
    assert.ok(!JSON.stringify(res.body).includes(TEST_API_KEY), 'a response leaked the key value');
  }
});

test('a terminal-only provider is rejected with 400 TERMINAL_ONLY', async () => {
  // T-866: 'cursor' has no credential-writer facet and is not a hosted vendor,
  // so both write and status short-circuit to TERMINAL_ONLY (no DB/role check).
  // (Facet providers claude/codex/opencode are covered by their own writer
  // suites; exercising them here would require a provisioned per-user tree/DB.)
  const set = await call('POST', '/api/providers/cursor/api-key', { user: 'u1', body: { apiKey: TEST_API_KEY } });
  assert.equal(set.status, 400);
  assert.equal(set.body.error?.code, 'TERMINAL_ONLY');

  const status = await call('GET', '/api/providers/cursor/api-key', { user: 'u1' });
  assert.equal(status.status, 400);
  assert.equal(status.body.error?.code, 'TERMINAL_ONLY');
});

test('capability endpoint reports the writer method per provider', async () => {
  // Vendor: native_file (nassaj-managed encrypted store), no targets list.
  const kimi = await call('GET', '/api/providers/kimi/api-key/capability', { user: 'u1' });
  assert.equal(kimi.status, 200);
  assert.deepEqual(kimi.body.data, { provider: 'kimi', method: 'native_file' });

  // Facet: opencode advertises native_file + its internal targets.
  const opencode = await call('GET', '/api/providers/opencode/api-key/capability', { user: 'u1' });
  assert.equal(opencode.status, 200);
  const oc = opencode.body.data as { provider: string; method: string; targets?: string[] };
  assert.equal(oc.provider, 'opencode');
  assert.equal(oc.method, 'native_file');
  assert.deepEqual(oc.targets, ['anthropic', 'openai', 'openrouter', 'glm']);

  // Facet: codex is cli_stdin (login CLI, key over stdin).
  const codex = await call('GET', '/api/providers/codex/api-key/capability', { user: 'u1' });
  assert.deepEqual(codex.body.data, { provider: 'codex', method: 'cli_stdin' });

  // Terminal-only: cursor reports none.
  const cursor = await call('GET', '/api/providers/cursor/api-key/capability', { user: 'u1' });
  assert.deepEqual(cursor.body.data, { provider: 'cursor', method: 'none' });
});

test('an empty or missing key is rejected with 400', async () => {
  const empty = await call('POST', '/api/providers/kimi/api-key', { user: 'u1', body: { apiKey: '   ' } });
  assert.equal(empty.status, 400);
  assert.equal(empty.body.error?.code, 'INVALID_API_KEY');

  const missing = await call('POST', '/api/providers/kimi/api-key', { user: 'u1', body: {} });
  assert.equal(missing.status, 400);
  assert.equal(missing.body.error?.code, 'INVALID_API_KEY');
});
