/**
 * engine-carrier-survival.providers.test.ts — tripwire: the provider-layer
 * meanings of kimi / glm / deepseek / qwen that are NOT an agent body and must
 * survive the deletion of the bodies:
 *
 *   - the registry still resolves kimi / glm / deepseek with a model catalog and
 *     a key status (the engine re-stamp path and the picker both read them);
 *   - `/api/providers/{kimi,glm,deepseek}/{models,auth/status,api-key}` and
 *     `/api/providers/qwen/api-key` still answer 200;
 *   - `delegate_to_vendor` still calls the vendor endpoint with the member key.
 *
 * The routes run through a real Express app mounted the way index.js mounts it,
 * with the auth middleware replaced by a header-driven principal. The encrypted
 * key store lives under a sandboxed home. No request leaves the machine: every
 * non-loopback `fetch` is recorded and refused.
 *
 * Runner: node:test (`npm run test:server -- <this file>`).
 */

import assert from 'node:assert/strict';
import fsSync from 'node:fs';
import fs from 'node:fs/promises';
import { type AddressInfo } from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, before, beforeEach, describe, it } from 'node:test';

import express, { type NextFunction, type Request, type Response } from 'express';

// The database path and the secrets key are fixed BEFORE any project module is
// imported, so the connection singleton can only ever open the throwaway file.
const sandboxRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), 'engine-carrier-survival-providers-'));
const VENDOR_KEY_ENV = ['KIMI_API_KEY', 'DEEPSEEK_API_KEY', 'GLM_API_KEY'] as const;
// Deterministic 32-byte AES key (base64): the store never writes a key file.
const TEST_SERVER_KEY = Buffer.alloc(32, 9).toString('base64');
const savedEnv: Record<string, string | undefined> = {};
for (const name of ['DATABASE_PATH', 'NASSAJ_PROVIDER_SECRETS_KEY', ...VENDOR_KEY_ENV]) {
  savedEnv[name] = process.env[name];
  delete process.env[name];
}
process.env.DATABASE_PATH = path.join(sandboxRoot, 'auth.db');
process.env.NASSAJ_PROVIDER_SECRETS_KEY = TEST_SERVER_KEY;

const { initializeDatabase, closeConnection, userDb } = await import('@/modules/database/index.js');
const { buildVendorDelegateMcp } = await import('@/modules/providers/index.js');
const { providerRegistry } = await import('@/modules/providers/provider.registry.js');
const { default: providerRoutes } = await import('@/modules/providers/provider.routes.js');
const { VENDOR_RUNTIME } = await import('@/modules/providers/shared/vendor/vendor-config.js');
const { PROVIDER_ANTHROPIC_ENDPOINT } = await import('@/services/isolation/provider-anthropic-endpoints.js');
const { _resetProviderSecretsServerKeyCache, setProviderKey } = await import(
  '@/services/isolation/provider-secrets-store.js'
);
const { AppError } = await import('@/shared/utils.js');

await initializeDatabase();
/** A real account: the catalog probe is admitted only for an authenticated member. */
const member = userDb.createUser('survival-provider-member', 'hash', 'user');
const MEMBER = String(member.id);

const ENGINES = ['kimi', 'glm', 'deepseek'] as const;
// Distinctive but not token-shaped: the leak-gate matches real vendor key
// prefixes (e.g. `sk-`), so this stays a plain marker string instead.
const TEST_API_KEY = 'survival-marker-DO-NOT-LEAK-1234567890';

let server: ReturnType<express.Express['listen']>;
let baseUrl = '';
let sandboxHome = '';
const realHomedir = os.homedir;
const realFetch = globalThis.fetch;

type OutboundCall = { url: string; init: RequestInit };
let outbound: OutboundCall[] = [];
/** When set, answers the next non-loopback request instead of refusing it. */
let vendorReply: unknown = null;

/** The production router behind a header-driven principal (mirrors authenticateToken). */
function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    const header = req.header('x-test-user');
    if (header) {
      (req as Request & { user?: Record<string, unknown> }).user = {
        id: /^\d+$/.test(header) ? Number(header) : header,
        role: 'user',
        status: 'active',
        is_active: 1,
        authenticationKind: 'session',
        authorizationGeneration: 1,
      };
      (req as Request & { assertCurrentIdentity?: () => boolean }).assertCurrentIdentity = () => true;
    }
    next();
  });
  app.use('/api/providers', providerRoutes);
  app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (err instanceof AppError) {
      res.status(err.statusCode).json({
        success: false,
        error: { code: err.code, message: err.message, details: err.details },
      });
      return;
    }
    res.status(500).json({ success: false, error: { code: 'INTERNAL_ERROR', message: String(err) } });
  });
  return app;
}

type ApiResponse = { status: number; body: { success?: boolean; data?: Record<string, unknown>; error?: unknown } };

async function call(method: string, routePath: string, body?: unknown, user = MEMBER): Promise<ApiResponse> {
  const res = await realFetch(`${baseUrl}${routePath}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-user': user },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : {} };
}

before(async () => {
  sandboxHome = path.join(sandboxRoot, 'home');
  await fs.mkdir(sandboxHome, { recursive: true });
  (os as unknown as { homedir: () => string }).homedir = () => sandboxHome;
  _resetProviderSecretsServerKeyCache();

  globalThis.fetch = (async (input: unknown, init: RequestInit = {}) => {
    outbound.push({ url: String(input instanceof Request ? input.url : input), init });
    if (vendorReply === null) throw new Error('network is disabled in this test');
    const reply = vendorReply;
    return {
      ok: true,
      status: 200,
      json: async () => reply,
      text: async () => JSON.stringify(reply),
    } as unknown as globalThis.Response;
  }) as unknown as typeof fetch;

  await new Promise<void>((resolve) => {
    server = buildApp().listen(0, '127.0.0.1', () => resolve());
  });
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

beforeEach(async () => {
  outbound = [];
  vendorReply = null;
  await fs.rm(path.join(sandboxHome, '.nassaj-users'), { recursive: true, force: true });
  await fs.rm(path.join(sandboxHome, '.nassaj-provider-secrets'), { recursive: true, force: true });
});

after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  globalThis.fetch = realFetch;
  (os as unknown as { homedir: () => string }).homedir = realHomedir;
  for (const [name, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  _resetProviderSecretsServerKeyCache();
  closeConnection();
  await fs.rm(sandboxRoot, { recursive: true, force: true });
});

describe('registry: the engine ids still resolve with a catalog and a key status', () => {
  for (const engine of ENGINES) {
    it(`${engine} exposes models and auth`, async () => {
      const provider = providerRegistry.resolveProvider(engine);
      assert.equal(provider.id, engine);

      const models = await provider.models.getSupportedModels(MEMBER);
      assert.ok(models.OPTIONS.length > 0, `${engine} must serve a non-empty catalog`);
      assert.ok(
        models.OPTIONS.some((option) => option.value === models.DEFAULT),
        `${engine} default must be one of its options`,
      );
      assert.ok(
        models.OPTIONS.some((option) => option.value === VENDOR_RUNTIME[engine].fallbackModels.DEFAULT),
        `${engine} must still list its embedded default model`,
      );

      const keyless = await provider.auth.getStatus(MEMBER);
      assert.equal(keyless.authenticated, false);
      setProviderKey(MEMBER, engine, TEST_API_KEY);
      const keyed = await provider.auth.getStatus(MEMBER);
      assert.equal(keyed.authenticated, true, `${engine} key status must follow the member's slot`);
      assert.equal(JSON.stringify(keyed).includes(TEST_API_KEY), false, 'the status never carries the key');
    });
  }
});

describe('routes: engine catalogs, key status and key slots answer 200', () => {
  for (const engine of ENGINES) {
    it(`GET /api/providers/${engine}/models serves the engine catalog`, async () => {
      const res = await call('GET', `/api/providers/${engine}/models`);
      assert.equal(res.status, 200, JSON.stringify(res.body));
      const models = res.body.data?.models as { OPTIONS: Array<{ value: string }>; DEFAULT: string };
      assert.equal(res.body.data?.provider, engine);
      assert.ok(models.OPTIONS.length > 0);
      assert.ok(models.OPTIONS.some((option) => option.value === VENDOR_RUNTIME[engine].fallbackModels.DEFAULT));
    });

    it(`the ${engine} key slot round-trips through api-key and auth/status`, async () => {
      const before = await call('GET', `/api/providers/${engine}/auth/status`);
      assert.equal(before.status, 200, JSON.stringify(before.body));
      assert.equal(before.body.data?.authenticated, false);

      const empty = await call('GET', `/api/providers/${engine}/api-key`);
      assert.equal(empty.status, 200, JSON.stringify(empty.body));
      assert.equal(empty.body.data?.configured, false);

      const set = await call('POST', `/api/providers/${engine}/api-key`, { apiKey: TEST_API_KEY });
      assert.equal(set.status, 200, JSON.stringify(set.body));
      assert.deepEqual(set.body.data, { provider: engine, configured: true });

      const stored = await call('GET', `/api/providers/${engine}/api-key`);
      assert.equal(stored.status, 200);
      assert.equal(stored.body.data?.configured, true);
      assert.equal(stored.body.data?.writable, true);

      const afterSet = await call('GET', `/api/providers/${engine}/auth/status`);
      assert.equal(afterSet.status, 200);
      assert.equal(afterSet.body.data?.authenticated, true);
      assert.equal(afterSet.body.data?.provider, engine);

      for (const response of [set, stored, afterSet]) {
        assert.equal(JSON.stringify(response.body).includes(TEST_API_KEY), false, 'no response echoes the key');
      }
    });
  }

  it('GET /api/providers/qwen/api-key answers 200 with the plan status', async () => {
    const res = await call('GET', '/api/providers/qwen/api-key');
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.data?.provider, 'qwen');
    assert.equal(res.body.data?.configured, false);
    assert.ok('qwenPlan' in (res.body.data ?? {}), 'the Alibaba card reads the plan status from this route');
  });
});

describe('delegate_to_vendor: the Claude tool still reaches each vendor with the member key', () => {
  type DelegateResult = { isError?: boolean; content: Array<{ type: string; text: string }> };

  /** Reads the registered handler out of the per-spawn MCP server the Claude body mounts. */
  function delegateHandler(userId: string): (args: Record<string, unknown>) => Promise<DelegateResult> {
    const built = buildVendorDelegateMcp(userId) as unknown as {
      type: string;
      name: string;
      instance: { _registeredTools: Record<string, { handler: (args: unknown) => unknown }> };
    };
    assert.equal(built.type, 'sdk', 'an in-process server: it never reaches argv');
    assert.equal(built.name, 'vendor-delegate');
    const entry = built.instance._registeredTools.delegate_to_vendor;
    assert.ok(entry, 'delegate_to_vendor must be registered');
    return (args) => Promise.resolve(entry.handler(args)) as Promise<DelegateResult>;
  }

  for (const engine of ENGINES) {
    it(`delegates to ${engine} on its own endpoint`, async () => {
      setProviderKey(MEMBER, engine, `sk-member-${engine}`);
      vendorReply = { content: [{ type: 'text', text: `answer from ${engine}` }] };

      const result = await delegateHandler(MEMBER)({ provider: engine, prompt: 'second opinion' });

      assert.notEqual(result.isError, true, JSON.stringify(result));
      assert.equal(result.content[0]?.text, `answer from ${engine}`);
      assert.equal(outbound.length, 1);
      assert.equal(outbound[0].url, `${PROVIDER_ANTHROPIC_ENDPOINT[engine]}/v1/messages`);
      const headers = outbound[0].init.headers as Record<string, string>;
      assert.equal(headers['x-api-key'], `sk-member-${engine}`);
    });
  }

  it('refuses without a stored key and sends nothing', async () => {
    const result = await delegateHandler('member-2')({ provider: 'glm', prompt: 'second opinion' });
    assert.equal(result.isError, true);
    assert.equal(outbound.length, 0);
  });
});
